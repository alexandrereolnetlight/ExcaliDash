import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "../generated/client";
import { generateApiKey, serializeApiKeyScopes } from "../auth/apiKeys";
import { getInternalApiBaseUrl } from "../mcp/internalApi";
import { createMcpServer } from "../mcp/tools";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";
import { startRuntimeServer } from "./runtimeServer";

// Must be set before the config module loads (imports are hoisted).
const previousFrontendUrl = vi.hoisted(() => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL =
    "https://first.example.test,https://second.example.test";
  return previous;
});

type ToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

const resultText = (result: unknown) =>
  (result as ToolResult).content.map((entry) => entry.text).join("\n");

describe("MCP endpoint", () => {
  let prisma: PrismaClient;
  let httpServer: Server;
  let baseUrl: string;
  let ownerKey: string;
  let readOnlyKey: string;
  let otherKey: string;
  const clients: Client[] = [];

  const createKey = async (userId: string, scopes?: string[]) => {
    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        userId,
        name: "MCP test",
        keyId: generated.keyId,
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
        scopes: serializeApiKeyScopes(scopes),
      },
    });
    return generated.token;
  };

  const connect = async (token: string, path = "/mcp") => {
    const client = new Client({ name: "mcp-integration-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}${path}`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    await client.connect(transport);
    clients.push(client);
    return client;
  };

  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => (await client.callTool({ name, arguments: args })) as ToolResult;

  const createdId = (result: ToolResult) => {
    const match = /^id: (\S+)$/m.exec(resultText(result));
    expect(match, resultText(result)).not.toBeNull();
    return match![1];
  };

  const loadScene = async (id: string) => {
    const drawing = await prisma.drawing.findUniqueOrThrow({ where: { id } });
    const elements = JSON.parse(drawing.elements) as any[];
    return {
      drawing,
      byId: new Map(elements.map((element) => [element.id, element])),
    };
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ httpServer } = await import("../index"));
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });
    const owner = await prisma.user.create({
      data: { email: "mcp-owner@test.local", passwordHash: "x", name: "Owner" },
    });
    const other = await prisma.user.create({
      data: { email: "mcp-other@test.local", passwordHash: "x", name: "Other" },
    });
    ownerKey = await createKey(owner.id);
    readOnlyKey = await createKey(owner.id, [
      "drawings:read",
      "collections:read",
    ]);
    otherKey = await createKey(other.id);
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.$disconnect();
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontendUrl;
  });

  it("calls the REST API on the address the server actually listens on", () => {
    expect(getInternalApiBaseUrl()).toBe(baseUrl);
  });

  it("initializes and lists the tools (with and without the /api prefix)", async () => {
    for (const path of ["/mcp", "/api/mcp"]) {
      const client = await connect(ownerKey, path);
      expect(client.getServerVersion()?.name).toBe("excalidash");
      expect(client.getInstructions()).toContain("Excalidraw");
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "create_drawing",
        "get_drawing",
        "list_collections",
        "list_drawings",
        "update_drawing",
      ]);
      const create = tools.find((tool) => tool.name === "create_drawing")!;
      expect(create.inputSchema.required).toEqual(
        expect.arrayContaining(["name", "elements"]),
      );
      expect(create.annotations?.readOnlyHint).toBe(false);
    }
  });

  it("rejects requests without a valid API key", async () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "curl", version: "1" },
      },
    };
    const post = (headers: Record<string, string>) =>
      fetch(`${baseUrl}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(initialize),
      });
    for (const headers of [
      {},
      { Authorization: "Bearer exd_invalid_invalid" },
      { Authorization: "Bearer not-an-api-key.jwt.token" },
      { Authorization: `Basic ${Buffer.from("a:b").toString("base64")}` },
    ]) {
      const response = await post(headers);
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      const body = await response.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.code).toBe(-32001);
    }
    // A browser Origin does not trip CSRF protection: the route is Bearer-only.
    const withOrigin = await post({
      Authorization: `Bearer ${ownerKey}`,
      Origin: "https://evil.example",
    });
    expect(withOrigin.status).toBe(200);

    const oauth = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource`,
    );
    expect(oauth.status).not.toBe(200);
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${ownerKey}` },
      });
      expect(response.status).toBe(405);
      expect((await response.json()).error.code).toBe(-32000);
    }
  });

  it("refuses write tools for read-only keys", async () => {
    const client = await connect(readOnlyKey);
    const result = await call(client, "create_drawing", {
      name: "Nope",
      elements: [{ type: "rectangle" }],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("drawings:write");
    const listed = await call(client, "list_drawings", {});
    expect(listed.isError).toBeFalsy();
  });

  it("creates, reads and edits a drawing end to end", async () => {
    const client = await connect(ownerKey);
    const created = await call(client, "create_drawing", {
      name: "Architecture",
      elements: [
        {
          id: "api",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          label: "API",
          backgroundColor: "#a5d8ff",
        },
        { id: "db", type: "ellipse", x: 400, y: 0, width: 160, height: 100 },
        {
          id: "flow",
          type: "arrow",
          startBinding: { elementId: "api" },
          endBinding: { elementId: "db" },
        },
        { id: "title", type: "text", x: 0, y: -60, text: "System" },
      ],
    });
    expect(created.isError, resultText(created)).toBeFalsy();
    const id = createdId(created);
    expect(resultText(created)).toContain(
      `url: https://first.example.test/editor/${id}`,
    );
    expect(resultText(created)).toContain("api -> ");

    const read = await call(client, "get_drawing", { id });
    const readText = resultText(read);
    expect(readText).toContain('Drawing "Architecture"');
    expect(readText).toContain("access: owner");
    expect(readText).toContain('"label":"API"');
    expect(readText).toContain('"start":"api"');
    expect(readText).toContain('"end":"db"');
    expect(readText).toContain('"text":"System"');

    const headerOnly = await call(client, "get_drawing", {
      id,
      includeElements: false,
    });
    expect(resultText(headerOnly)).not.toContain('"type"');

    const initial = await loadScene(id);
    const labelId = initial.byId
      .get("api")
      .boundElements.find((entry: any) => entry.type === "text").id;

    const updated = await call(client, "update_drawing", {
      id,
      addElements: [
        { id: "cache", type: "diamond", x: 400, y: 250, label: "Cache" },
      ],
      updateElements: [{ id: "api", y: 40, label: "Gateway" }],
      removeElementIds: ["db"],
    });
    expect(updated.isError, resultText(updated)).toBeFalsy();
    expect(resultText(updated)).toContain("added: 1 (ids: cache)");
    expect(resultText(updated)).toContain("removed: 1");

    const after = await loadScene(id);
    expect(after.drawing.version).toBe(initial.drawing.version + 1);
    expect(after.byId.get("db")).toMatchObject({ isDeleted: true, version: 2 });
    expect(after.byId.get("flow").endBinding).toBeNull();
    expect(after.byId.get("api")).toMatchObject({ y: 40, version: 2 });
    expect(after.byId.get(labelId)).toMatchObject({
      text: "Gateway",
      containerId: "api",
    });
    expect(after.byId.get("cache")).toMatchObject({
      type: "diamond",
      version: 1,
    });

    const reread = resultText(await call(client, "get_drawing", { id }));
    expect(reread).toContain('"label":"Gateway"');
    expect(reread).toContain('"label":"Cache"');
    expect(reread).not.toContain('"id":"db"');

    const bad = await call(client, "update_drawing", {
      id,
      updateElements: [{ id: "missing", x: 1 }],
    });
    expect(bad.isError).toBe(true);
    expect(resultText(bad)).toContain('no element with id "missing"');
  });

  it("does not let another user read or edit an unshared drawing", async () => {
    const owner = await connect(ownerKey);
    const id = createdId(
      await call(owner, "create_drawing", {
        name: "Private",
        elements: [{ id: "secret", type: "rectangle" }],
      }),
    );
    const intruder = await connect(otherKey);
    const read = await call(intruder, "get_drawing", { id });
    expect(read.isError).toBe(true);
    expect(resultText(read)).toContain("not found");
    const write = await call(intruder, "update_drawing", {
      id,
      removeElementIds: ["secret"],
    });
    expect(write.isError).toBe(true);
    const listed = resultText(await call(intruder, "list_drawings", {}));
    expect(listed).not.toContain(id);
    const scene = await loadScene(id);
    expect(scene.byId.get("secret").isDeleted).toBe(false);
  });

  it("lists drawings and collections", async () => {
    const collectionResponse = await fetch(`${baseUrl}/collections`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Diagrams" }),
    });
    expect(collectionResponse.status).toBe(200);
    const collection = await collectionResponse.json();

    const client = await connect(ownerKey);
    const collections = resultText(await call(client, "list_collections", {}));
    expect(collections).toContain(
      JSON.stringify({ id: collection.id, name: "Diagrams" }),
    );

    const id = createdId(
      await call(client, "create_drawing", {
        name: "Sequence flow",
        collectionId: collection.id,
        elements: [],
      }),
    );
    const all = resultText(await call(client, "list_drawings", {}));
    expect(all).toContain('"name":"Sequence flow"');
    expect(all).toContain('"collection":"Diagrams"');
    expect(all).toContain(`"url":"https://first.example.test/editor/${id}"`);

    const searched = resultText(
      await call(client, "list_drawings", { query: "sequence", limit: 5 }),
    );
    expect(searched).toMatch(/^1 of 1 drawings\./);
    const filtered = resultText(
      await call(client, "list_drawings", { collectionId: collection.id }),
    );
    expect(filtered).toContain(id);
    expect(filtered).not.toContain("Architecture");
  });
});

describe("MCP endpoint in a production runtime", () => {
  it("reaches the REST API over loopback despite the HTTPS redirect", async () => {
    setupTestDb();
    const prisma = getTestPrisma();
    try {
      await prisma.systemConfig.upsert({
        where: { id: "default" },
        update: { authEnabled: true, registrationEnabled: false },
        create: {
          id: "default",
          authEnabled: true,
          registrationEnabled: false,
        },
      });
      const user = await prisma.user.create({
        data: { email: "mcp-prod@test.local", passwordHash: "x", name: "P" },
      });
      const generated = generateApiKey();
      await prisma.apiKey.create({
        data: {
          userId: user.id,
          name: "MCP prod",
          keyId: generated.keyId,
          tokenHash: generated.tokenHash,
          prefix: generated.prefix,
          scopes: serializeApiKeyScopes(),
        },
      });
      // HTTPS redirect is enforced (production + https FRONTEND_URL).
      const server = await startRuntimeServer({
        API_KEY_HASH_PEPPER: config.apiKeyHashPepper,
      });
      try {
        const redirected = await fetch(`${server.url}/api/mcp`, {
          method: "POST",
          redirect: "manual",
        });
        expect(redirected.status).toBeGreaterThanOrEqual(300);
        expect(redirected.status).toBeLessThan(400);

        const client = new Client({ name: "prod-test", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${server.url}/api/mcp`), {
            requestInit: {
              headers: {
                Authorization: `Bearer ${generated.token}`,
                "X-Forwarded-Proto": "https",
                "X-Forwarded-For": "203.0.113.7",
              },
            },
          }),
        );
        try {
          const created = (await client.callTool({
            name: "create_drawing",
            arguments: { name: "Prod", elements: [{ type: "ellipse" }] },
          })) as ToolResult;
          expect(created.isError, resultText(created)).toBeFalsy();
          expect(resultText(created)).toMatch(
            /url: https:\/\/first\.example\.test\/editor\/[0-9a-f-]{36}/,
          );
          const listed = (await client.callTool({
            name: "list_drawings",
            arguments: {},
          })) as ToolResult;
          expect(resultText(listed)).toContain('"name":"Prod"');
        } finally {
          await client.close();
        }
      } finally {
        await server.stop();
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("MCP update_drawing version conflicts", () => {
  const drawing = {
    id: "d1",
    name: "Busy",
    version: 4,
    accessLevel: "owner",
    elements: [{ id: "r", type: "rectangle", x: 0, y: 0, version: 1 }],
  };

  const run = async (putStatuses: number[]) => {
    const calls: { method: string; body?: any }[] = [];
    const server = createMcpServer({
      scopes: ["drawings:read", "drawings:write"],
      publicOrigin: "https://app.test",
      serverVersion: "test",
      api: {
        request: async (method, _path, body) => {
          calls.push({ method, body });
          if (method === "GET") return { ok: true, status: 200, body: drawing };
          const status = putStatuses.shift() ?? 200;
          return {
            ok: status === 200,
            status,
            body: status === 200 ? { ...drawing, version: 5 } : {},
          };
        },
      },
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "conflict-test", version: "1" });
    await client.connect(clientTransport);
    const result = (await client.callTool({
      name: "update_drawing",
      arguments: { id: "d1", updateElements: [{ id: "r", x: 10 }] },
    })) as ToolResult;
    await client.close();
    return { result, calls };
  };

  it("retries once after a conflict", async () => {
    const { result, calls } = await run([409, 200]);
    expect(result.isError).toBeFalsy();
    expect(calls.map((entry) => entry.method)).toEqual([
      "GET",
      "PUT",
      "GET",
      "PUT",
    ]);
    expect(calls[1].body.version).toBe(4);
    expect(calls[1].body.elements[0]).toMatchObject({ x: 10, version: 2 });
  });

  it("reports a second conflict without saving", async () => {
    const { result } = await run([409, 409]);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Nothing was saved");
  });
});
