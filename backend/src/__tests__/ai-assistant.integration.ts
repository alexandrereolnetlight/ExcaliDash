/**
 * /auth/ai/* and POST /agent/chat against a fake LLM proxy: a local HTTP
 * server that speaks GET /v1/models and enough of the Anthropic Messages
 * streaming protocol (SSE) for the SDK. Nothing reaches a real proxy.
 */
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { PrismaClient } from "../generated/client";
import { getTestPrisma, setupTestDb } from "./testUtils";

// Capture the app's Socket.IO server so a test can watch the live broadcast.
const captured = vi.hoisted(() => ({ io: null as any }));
vi.mock("socket.io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("socket.io")>();
  class CapturingServer extends actual.Server {
    constructor(...args: any[]) {
      super(...args);
      captured.io = this;
    }
  }
  return { ...actual, Server: CapturingServer };
});

import { config } from "../config";
import { createEphemeralApiKey, generateApiKey } from "../auth/apiKeys";
import { clearProxyModelsCache } from "../ai/proxy";

const SHARED_KEY = "sk-shared-test-key-0001";
const PERSONAL_KEY = "sk-personal-test-key-wxyz";
const REJECTED_KEY = "sk-rejected-test-key-0000";
const MODEL = "claude-opus-5-5";
const userAgent = "vitest-ai-assistant";

type RecordedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  rawBody: string;
};

type ScriptStep =
  | { kind: "message"; message: FakeMessage; onRequest?: () => Promise<void> }
  | { kind: "error"; status: number; type: string; message: string };

type FakeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

type FakeMessage = {
  content: FakeBlock[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
};

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const split = (value: string) => {
  const middle = Math.max(1, Math.floor(value.length / 2));
  return [value.slice(0, middle), value.slice(middle)];
};

/** The SSE event sequence of one streamed Messages API response. */
const messageEvents = (message: FakeMessage, id: string): string[] => {
  const usage = message.usage ?? { input_tokens: 100, output_tokens: 20 };
  const events = [
    sse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ];
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
      );
      for (const part of split(block.text)) {
        events.push(
          sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: part },
          }),
        );
      }
    } else if (block.type === "thinking") {
      events.push(
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
        sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        }),
      );
    } else {
      events.push(
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        }),
      );
      for (const part of split(JSON.stringify(block.input))) {
        events.push(
          sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: part },
          }),
        );
      }
    }
    events.push(
      sse("content_block_stop", { type: "content_block_stop", index }),
    );
  });
  events.push(
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }),
    sse("message_stop", { type: "message_stop" }),
  );
  return events;
};

const createFakeProxy = () => {
  const requests: RecordedRequest[] = [];
  const script: ScriptStep[] = [];
  let counter = 0;
  const validKeys = new Set([SHARED_KEY, PERSONAL_KEY]);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body: any = null;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        body = null;
      }
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
        rawBody,
      });
      const auth = req.headers.authorization ?? "";
      const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (req.method === "GET" && req.url === "/v1/models") {
        if (!validKeys.has(key)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "bad key" } }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            data: [
              { id: MODEL, type: "model" },
              { id: "claude-sonnet-5-5", type: "model" },
            ],
            object: "list",
          }),
        );
      }
      if (req.method === "POST" && req.url === "/v1/messages") {
        const step = script.shift();
        if (!step) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              type: "error",
              error: { type: "api_error", message: "script exhausted" },
            }),
          );
        }
        if (step.kind === "error") {
          res.writeHead(step.status, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              type: "error",
              error: { type: step.type, message: step.message },
            }),
          );
        }
        if (step.onRequest) await step.onRequest();
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        for (const event of messageEvents(step.message, `msg_${++counter}`)) {
          res.write(event);
        }
        return res.end();
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  return { server, requests, script };
};

type SseEvent = { event: string; data: any };

const parseSse = (text: string): SseEvent[] =>
  text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk && !chunk.startsWith(":"))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event =
        lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      return { event, data: data ? JSON.parse(data) : null };
    });

const textParser = (res: any, callback: (err: any, body: string) => void) => {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => (data += chunk));
  res.on("end", () => callback(null, data));
};

describe("AI assistant", () => {
  let prisma: PrismaClient;
  let app: any;
  let httpServer: http.Server;
  let agent: any;
  let csrfHeader: string;
  let csrfToken: string;
  const proxy = createFakeProxy();
  let proxyUrl: string;
  const users: Record<string, { id: string; token: string }> = {};
  const encryptionKey = crypto.randomBytes(32);

  const makeUser = async (name: string) => {
    const user = await prisma.user.create({
      data: {
        email: `${name}@ai.test.local`,
        passwordHash: "unused",
        name,
      },
    });
    const token = jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      { expiresIn: "1h" },
    );
    users[name] = { id: user.id, token };
    return users[name];
  };

  const createDrawing = (userId: string, elements: unknown[] = []) =>
    prisma.drawing.create({
      data: {
        userId,
        name: "Architecture",
        elements: JSON.stringify(elements),
        appState: JSON.stringify({ viewBackgroundColor: "#ffffff" }),
        files: "{}",
        version: 1,
      },
    });

  const withSession = (req: any, user: { token: string }, csrf = true) => {
    req
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${user.token}`);
    return csrf ? req.set(csrfHeader, csrfToken) : req;
  };

  const chat = (user: { token: string }, body: Record<string, unknown>) =>
    withSession(agent.post("/agent/chat"), user)
      .send(body)
      .buffer(true)
      .parse(textParser);

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app, httpServer } = await import("../index"));
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", () => resolve()),
    );
    await new Promise<void>((resolve) =>
      proxy.server.listen(0, "127.0.0.1", () => resolve()),
    );
    proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });
    for (const name of ["owner", "viewer", "personal", "nokey", "busy"]) {
      await makeUser(name);
    }
    agent = request.agent(app);
    const csrf = await agent.get("/csrf-token").set("User-Agent", userAgent);
    csrfHeader = csrf.body.header;
    csrfToken = csrf.body.token;
  });

  beforeEach(() => {
    Object.assign(config.ai, {
      enabled: true,
      proxyBaseUrl: proxyUrl,
      proxyApiKey: SHARED_KEY,
      model: MODEL,
      effort: "medium",
      keyEncryptionKey: encryptionKey,
      serverFallbacks: false,
    });
    proxy.requests.length = 0;
    proxy.script.length = 0;
    clearProxyModelsCache();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
    await prisma.$disconnect();
  });

  describe("/auth/ai", () => {
    it("reports a disabled assistant and refuses key changes", async () => {
      config.ai.enabled = false;
      const status = await withSession(
        agent.get("/auth/ai/status"),
        users.owner,
        false,
      );
      expect(status.status).toBe(200);
      expect(status.body).toEqual({ enabled: false });
      const put = await withSession(
        agent.put("/auth/ai/key"),
        users.owner,
      ).send({ key: PERSONAL_KEY });
      expect(put.status).toBe(404);
      expect(proxy.requests).toHaveLength(0);
    });

    it("reports the shared key and the models it can use", async () => {
      const response = await withSession(
        agent.get("/auth/ai/status"),
        users.owner,
        false,
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        enabled: true,
        model: MODEL,
        sharedKeyAvailable: true,
        personalKeysEnabled: true,
        credentialAvailable: true,
        credentialSource: "shared",
        usingPersonalKey: false,
        personalKey: null,
        models: ["claude-opus-5-5", "claude-sonnet-5-5"],
        modelAvailable: true,
      });
      expect(JSON.stringify(response.body)).not.toContain(SHARED_KEY);
      const modelsCall = proxy.requests.find((r) => r.url === "/v1/models");
      expect(modelsCall?.headers.authorization).toBe(`Bearer ${SHARED_KEY}`);
      // Cached briefly: a second status call does not hit the proxy again.
      await withSession(agent.get("/auth/ai/status"), users.owner, false);
      expect(proxy.requests.filter((r) => r.url === "/v1/models")).toHaveLength(
        1,
      );
    });

    it("validates, encrypts and removes a personal key", async () => {
      const user = users.personal;
      const malformed = await withSession(agent.put("/auth/ai/key"), user).send(
        { key: "not-a-key" },
      );
      expect(malformed.status).toBe(400);
      expect(proxy.requests).toHaveLength(0);

      const rejected = await withSession(agent.put("/auth/ai/key"), user).send({
        key: REJECTED_KEY,
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.message).toMatch(/rejected/);
      expect(proxy.requests.at(-1)?.headers.authorization).toBe(
        `Bearer ${REJECTED_KEY}`,
      );
      expect(
        await prisma.userAiCredential.findUnique({
          where: { userId: user.id },
        }),
      ).toBeNull();

      const noCsrf = await withSession(
        agent.put("/auth/ai/key"),
        user,
        false,
      ).send({ key: PERSONAL_KEY });
      expect(noCsrf.status).toBe(403);

      const saved = await withSession(agent.put("/auth/ai/key"), user).send({
        key: `  ${PERSONAL_KEY} `,
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        usingPersonalKey: true,
        credentialSource: "personal",
        personalKey: { hint: "wxyz" },
      });
      expect(JSON.stringify(saved.body)).not.toContain(PERSONAL_KEY);
      const row = await prisma.userAiCredential.findUniqueOrThrow({
        where: { userId: user.id },
      });
      expect(row.keyEncrypted).not.toContain(PERSONAL_KEY);
      expect(row.keyHint).toBe("wxyz");

      const removed = await withSession(
        agent.delete("/auth/ai/key"),
        user,
      ).send();
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({
        usingPersonalKey: false,
        credentialSource: "shared",
        personalKey: null,
      });
    });

    it("refuses personal keys when no encryption key is configured", async () => {
      config.ai.keyEncryptionKey = null;
      const response = await withSession(
        agent.put("/auth/ai/key"),
        users.personal,
      ).send({ key: PERSONAL_KEY });
      expect(response.status).toBe(409);
      expect(proxy.requests).toHaveLength(0);
    });

    it("does not accept API keys", async () => {
      const generated = generateApiKey();
      await prisma.apiKey.create({
        data: {
          userId: users.owner.id,
          name: "api key",
          keyId: generated.keyId,
          tokenHash: generated.tokenHash,
          prefix: generated.prefix,
        },
      });
      const response = await request(app)
        .get("/auth/ai/status")
        .set("Authorization", `Bearer ${generated.token}`);
      expect(response.status).toBe(403);
      const chatResponse = await request(app)
        .post("/agent/chat")
        .set("Authorization", `Bearer ${generated.token}`)
        .send({ drawingId: "x", message: "hi" });
      expect(chatResponse.status).toBe(403);
    });

    it("hides the assistant's per-request keys from the API key list", async () => {
      const ephemeral = await createEphemeralApiKey(prisma, {
        userId: users.owner.id,
        name: "AI assistant session",
        scopes: ["drawings:read"],
        ttlMs: 60_000,
      });
      const response = await withSession(
        agent.get("/auth/api-keys"),
        users.owner,
        false,
      );
      expect(response.status).toBe(200);
      expect(
        response.body.apiKeys.map((key: { id: string }) => key.id),
      ).not.toContain(ephemeral.id);
      await prisma.apiKey.delete({ where: { id: ephemeral.id } });
    });
  });

  describe("POST /agent/chat", () => {
    it("streams text, runs update_drawing through the REST API and cleans up", async () => {
      const user = users.owner;
      const drawing = await createDrawing(user.id, [
        {
          id: "existing",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
        },
      ]);
      const roomId = `drawing_${drawing.id}`;
      // A (fake) collaborator has the drawing open, so the save is broadcast.
      captured.io.sockets.adapter.rooms.set(roomId, new Set(["ghost-socket"]));
      const broadcasts: Array<{ room: string; event: string; payload: any }> =
        [];
      const toSpy = vi
        .spyOn(captured.io, "to")
        .mockImplementation((room: any) => {
          const target = {
            emit: (event: string, payload: unknown) => {
              broadcasts.push({ room, event, payload });
              return true;
            },
            except: () => target,
          };
          return target as any;
        });

      let ephemeralKeysDuringRequest = -1;
      proxy.script.push(
        {
          kind: "message",
          onRequest: async () => {
            ephemeralKeysDuringRequest = await prisma.apiKey.count({
              where: { userId: user.id, ephemeral: true },
            });
          },
          message: {
            content: [
              { type: "thinking", signature: "sig-1" },
              { type: "text", text: "I'll add a box next to it." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "update_drawing",
                input: {
                  id: drawing.id,
                  addElements: [
                    {
                      type: "rectangle",
                      id: "box-ai",
                      x: 200,
                      y: 0,
                      width: 200,
                      height: 100,
                      label: "Cache",
                    },
                  ],
                },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 1000, output_tokens: 50 },
          },
        },
        {
          kind: "message",
          message: {
            content: [{ type: "text", text: "Added a Cache box." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1200, output_tokens: 10 },
          },
        },
      );

      const snapshotsBefore = await prisma.drawingSnapshot.count({
        where: { drawingId: drawing.id },
      });
      const response = await chat(user, {
        drawingId: drawing.id,
        messages: [
          { role: "user", content: "What is this?" },
          { role: "assistant", content: "An architecture sketch." },
        ],
        message: "Add a cache box",
        context: {
          selectedElementIds: ["existing"],
          viewport: { x: -50, y: -40, width: 1200, height: 800, zoom: 1 },
        },
      });
      toSpy.mockRestore();
      captured.io.sockets.adapter.rooms.delete(roomId);

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.headers["x-accel-buffering"]).toBe("no");
      expect(response.headers["cache-control"]).toContain("no-cache");
      const events = parseSse(response.body);
      const text = events
        .filter((e) => e.event === "text")
        .map((e) => e.data.text)
        .join("");
      expect(text).toContain("I'll add a box next to it.");
      expect(text).toContain("Added a Cache box.");
      expect(text).toContain("History");
      expect(events.filter((e) => e.event === "text").length).toBeGreaterThan(
        3,
      );
      const toolEvents = events.filter((e) => e.event === "tool");
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0].data).toMatchObject({
        name: "update_drawing",
        isError: false,
      });
      expect(toolEvents[0].data.summary).toMatch(/^Added \d+ elements?$/);
      const done = events.find((e) => e.event === "done");
      expect(done?.data).toMatchObject({
        outcome: "completed",
        stopReason: "end_turn",
        changedDrawing: true,
        iterations: 2,
        usage: { input_tokens: 2200, output_tokens: 60 },
      });
      expect(events.some((e) => e.event === "error")).toBe(false);

      // The drawing was saved through PUT /drawings/:id: new version, history
      // snapshot and a persisted broadcast to the open editor.
      const saved = await prisma.drawing.findUniqueOrThrow({
        where: { id: drawing.id },
      });
      expect(saved.version).toBe(2);
      const ids = JSON.parse(saved.elements).map((e: any) => e.id);
      expect(ids).toEqual(expect.arrayContaining(["existing", "box-ai"]));
      expect(
        await prisma.drawingSnapshot.count({
          where: { drawingId: drawing.id },
        }),
      ).toBe(snapshotsBefore + 1);
      const update = broadcasts.find((b) => b.event === "element-update");
      expect(update?.room).toBe(roomId);
      expect(update?.payload).toMatchObject({
        drawingId: drawing.id,
        persisted: true,
        version: 2,
      });

      // The per-request key existed during the run and is gone afterwards.
      expect(ephemeralKeysDuringRequest).toBe(1);
      expect(
        await prisma.apiKey.count({
          where: { userId: user.id, ephemeral: true },
        }),
      ).toBe(0);

      // What was sent to the proxy.
      const calls = proxy.requests.filter((r) => r.url === "/v1/messages");
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.headers.authorization).toBe(`Bearer ${SHARED_KEY}`);
        expect(call.headers["x-api-key"]).toBeUndefined();
        expect(call.rawBody).not.toContain("eager_input_streaming");
        expect(call.rawBody).not.toContain("$ref");
        expect(call.rawBody).not.toContain('"$schema"');
        expect(call.body).toMatchObject({
          model: MODEL,
          max_tokens: 16000,
          stream: true,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          metadata: { user_id: user.id },
        });
        expect(call.body).not.toHaveProperty("tool_choice");
        expect(call.body).not.toHaveProperty("temperature");
        expect(call.body).not.toHaveProperty("fallbacks");
        expect(call.body).not.toHaveProperty("thread");
        expect(call.body.thinking).not.toHaveProperty("budget_tokens");
        expect(call.body.system[0].cache_control).toEqual({
          type: "ephemeral",
        });
        expect(call.body.system[0].text).not.toContain(drawing.id);
        expect(call.body.tools.map((tool: any) => tool.name)).toEqual([
          "list_drawings",
          "list_collections",
          "get_drawing",
          "create_drawing",
          "update_drawing",
        ]);
        expect(call.headers["anthropic-beta"]).toBeUndefined();
        const getDrawingTool = call.body.tools[2];
        expect(getDrawingTool.input_schema).toMatchObject({
          type: "object",
          required: ["id"],
          properties: { includeElements: { type: "boolean" } },
        });
        expect(getDrawingTool).not.toHaveProperty("eager_input_streaming");
      }
      const first = calls[0].body;
      expect(first.messages.map((m: any) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      const latest = first.messages[2].content;
      expect(latest[0].text).toContain(`Current drawing id: ${drawing.id}`);
      expect(latest[0].text).toContain("Selected element ids: existing");
      expect(latest[1].text).toBe("Add a cache box");
      // The second turn replays the assistant turn (thinking block included)
      // and answers the tool call.
      const second = calls[1].body.messages;
      expect(second[3].role).toBe("assistant");
      expect(second[3].content[0]).toMatchObject({
        type: "thinking",
        signature: "sig-1",
      });
      expect(second[4].role).toBe("user");
      expect(second[4].content[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_1",
      });
      expect(JSON.stringify(second[4].content[0].content)).toContain(
        "Updated drawing",
      );
    });

    it("uses the personal key when one is saved, and server fallbacks when enabled", async () => {
      const user = users.personal;
      const saved = await withSession(agent.put("/auth/ai/key"), user).send({
        key: PERSONAL_KEY,
      });
      expect(saved.status).toBe(200);
      config.ai.serverFallbacks = true;
      const drawing = await createDrawing(user.id);
      proxy.script.push({
        kind: "message",
        message: {
          content: [{ type: "text", text: "Hello!" }],
          stop_reason: "end_turn",
        },
      });
      const response = await chat(user, {
        drawingId: drawing.id,
        message: "Hi",
      });
      expect(response.status).toBe(200);
      const call = proxy.requests.find((r) => r.url === "/v1/messages")!;
      expect(call.headers.authorization).toBe(`Bearer ${PERSONAL_KEY}`);
      expect(call.body.fallbacks).toBe("default");
      expect(call.headers["anthropic-beta"]).toBe(
        "server-side-fallback-2026-07-01",
      );
      const events = parseSse(response.body);
      expect(events.find((e) => e.event === "done")?.data).toMatchObject({
        changedDrawing: false,
      });
      await prisma.userAiCredential.delete({ where: { userId: user.id } });
    });

    it("returns invalid tool input to the model as an error", async () => {
      const drawing = await createDrawing(users.owner.id);
      proxy.script.push(
        {
          kind: "message",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_bad",
                name: "update_drawing",
                input: { addElements: "nope" },
              },
            ],
            stop_reason: "tool_use",
          },
        },
        {
          kind: "message",
          message: {
            content: [{ type: "text", text: "Sorry, let me retry." }],
            stop_reason: "end_turn",
          },
        },
      );
      const response = await chat(users.owner, {
        drawingId: drawing.id,
        message: "Add a box",
      });
      const events = parseSse(response.body);
      expect(events.filter((e) => e.event === "tool")).toHaveLength(0);
      expect(events.find((e) => e.event === "done")?.data).toMatchObject({
        outcome: "completed",
        changedDrawing: false,
      });
      const calls = proxy.requests.filter((r) => r.url === "/v1/messages");
      const toolResult = calls[1].body.messages.at(-1).content[0];
      expect(toolResult).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_bad",
        is_error: true,
      });
      const unchanged = await prisma.drawing.findUniqueOrThrow({
        where: { id: drawing.id },
      });
      expect(unchanged.version).toBe(1);
    });

    it("reports a refusal", async () => {
      const drawing = await createDrawing(users.owner.id);
      proxy.script.push({
        kind: "message",
        message: { content: [], stop_reason: "refusal" },
      });
      const response = await chat(users.owner, {
        drawingId: drawing.id,
        message: "Hi",
      });
      const events = parseSse(response.body);
      expect(events.find((e) => e.event === "done")?.data).toMatchObject({
        outcome: "refusal",
        stopReason: "refusal",
      });
      expect(
        events
          .filter((e) => e.event === "text")
          .map((e) => e.data.text)
          .join(""),
      ).toContain("declined");
    });

    it("stops after 15 tool-use iterations", async () => {
      const drawing = await createDrawing(users.owner.id);
      for (let i = 0; i < 16; i++) {
        proxy.script.push({
          kind: "message",
          message: {
            content: [
              {
                type: "tool_use",
                id: `toolu_${i}`,
                name: "get_drawing",
                input: { id: drawing.id, includeElements: false },
              },
            ],
            stop_reason: "tool_use",
          },
        });
      }
      const response = await chat(users.owner, {
        drawingId: drawing.id,
        message: "Keep reading",
      });
      const events = parseSse(response.body);
      expect(
        proxy.requests.filter((r) => r.url === "/v1/messages"),
      ).toHaveLength(15);
      expect(events.filter((e) => e.event === "tool")).toHaveLength(15);
      expect(events.find((e) => e.event === "done")?.data).toMatchObject({
        outcome: "max_iterations",
        iterations: 15,
      });
      expect(
        events
          .filter((e) => e.event === "text")
          .map((e) => e.data.text)
          .join(""),
      ).toContain("stopped after 15 steps");
    });

    it("maps a rejected key to a friendly error event", async () => {
      const drawing = await createDrawing(users.owner.id);
      proxy.script.push({
        kind: "error",
        status: 401,
        type: "authentication_error",
        message: "invalid key",
      });
      const response = await chat(users.owner, {
        drawingId: drawing.id,
        message: "Hi",
      });
      expect(response.status).toBe(200);
      const error = parseSse(response.body).find((e) => e.event === "error");
      expect(error?.data.code).toBe("key_rejected");
      expect(error?.data.message).toContain("AI_PROXY_API_KEY");
      expect(
        await prisma.apiKey.count({
          where: { userId: users.owner.id, ephemeral: true },
        }),
      ).toBe(0);
    });

    it("refuses users without edit access", async () => {
      const drawing = await createDrawing(users.owner.id);
      const notShared = await chat(users.viewer, {
        drawingId: drawing.id,
        message: "Hi",
      });
      expect(notShared.status).toBe(404);
      expect(JSON.parse(notShared.body).code).toBe("drawing_unavailable");

      await prisma.drawingPermission.create({
        data: {
          drawingId: drawing.id,
          granteeUserId: users.viewer.id,
          permission: "view",
          createdByUserId: users.owner.id,
        },
      });
      const viewOnly = await chat(users.viewer, {
        drawingId: drawing.id,
        message: "Hi",
      });
      expect(viewOnly.status).toBe(403);
      expect(JSON.parse(viewOnly.body).code).toBe("read_only");
      expect(proxy.requests).toHaveLength(0);
      expect(
        await prisma.apiKey.count({
          where: { userId: users.viewer.id, ephemeral: true },
        }),
      ).toBe(0);
    });

    it("returns 404 when the assistant is disabled", async () => {
      config.ai.enabled = false;
      const response = await chat(users.owner, {
        drawingId: "anything",
        message: "Hi",
      });
      expect(response.status).toBe(404);
    });

    it("explains a missing credential", async () => {
      config.ai.proxyApiKey = null;
      const drawing = await createDrawing(users.nokey.id);
      const response = await chat(users.nokey, {
        drawingId: drawing.id,
        message: "Hi",
      });
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body).message).toContain("AI_PROXY_API_KEY");
    });

    it("validates request sizes and requires CSRF", async () => {
      const tooLong = await chat(users.owner, {
        drawingId: "d",
        message: "x".repeat(9000),
      });
      expect(tooLong.status).toBe(400);
      const longHistory = await chat(users.owner, {
        drawingId: "d",
        message: "hi",
        messages: Array.from({ length: 5 }, () => ({
          role: "user",
          content: "y".repeat(15_000),
        })),
      });
      expect(longHistory.status).toBe(413);
      const noCsrf = await withSession(
        agent.post("/agent/chat"),
        users.owner,
        false,
      ).send({ drawingId: "d", message: "hi" });
      expect(noCsrf.status).toBe(403);
    });

    it("rate-limits each user", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        const response = await chat(users.busy, { drawingId: "", message: "" });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 30).every((status) => status === 400)).toBe(
        true,
      );
      expect(statuses[30]).toBe(429);
      // Other users are not affected.
      const other = await chat(users.owner, { drawingId: "", message: "" });
      expect(other.status).toBe(400);
    });
  });
});
