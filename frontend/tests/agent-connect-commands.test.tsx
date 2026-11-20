import { describe, expect, it } from "vitest";
import {
  API_KEY_PLACEHOLDER,
  buildAgentCommands,
  buildApiKeyAgentCommands,
  describeAgentAccess,
  getMcpUrl,
  isLoopbackRedirectUrl,
} from "../src/utils/agentConnect";

const ORIGIN = "https://excalight.sandbox.edgez.live";
const TOKEN = "exd_abcdefghijklmnop_secret-Value_123";

describe("AI agent connection commands", () => {
  it("points at the /api/mcp endpoint of the current origin", () => {
    expect(getMcpUrl(ORIGIN)).toBe(`${ORIGIN}/api/mcp`);
    expect(getMcpUrl(`${ORIGIN}/`)).toBe(`${ORIGIN}/api/mcp`);
    expect(getMcpUrl("http://localhost:6767")).toBe(
      "http://localhost:6767/api/mcp",
    );
  });

  it("registers the server without a key so the agent signs in with OAuth", () => {
    const commands = buildAgentCommands(`${ORIGIN}/`);
    expect(commands.mcpUrl).toBe(`${ORIGIN}/api/mcp`);
    expect(commands.claudeCode).toBe(
      `claude mcp add --scope user --transport http excalight ${ORIGIN}/api/mcp`,
    );
    expect(commands.codex.split("\n")).toEqual([
      `codex mcp add excalight --url ${ORIGIN}/api/mcp`,
      "codex mcp login excalight",
    ]);
    expect(commands.claudeCode).not.toContain("Authorization");
  });

  it("fills a freshly created key into the API-key fallback", () => {
    const commands = buildApiKeyAgentCommands(ORIGIN, TOKEN);
    expect(commands.mcpUrl).toBe(`${ORIGIN}/api/mcp`);
    expect(commands.claudeCode).toBe(
      `claude mcp add --scope user --transport http excalight ${ORIGIN}/api/mcp --header "Authorization: Bearer ${TOKEN}"`,
    );
    expect(commands.codex).toBe(
      [
        `export EXCALIGHT_API_KEY=${TOKEN}`,
        `codex mcp add excalight --url ${ORIGIN}/api/mcp --bearer-token-env-var EXCALIGHT_API_KEY`,
      ].join("\n"),
    );
  });

  it("uses a placeholder until a key is created", () => {
    for (const token of [undefined, null, "", "   "]) {
      const commands = buildApiKeyAgentCommands(ORIGIN, token);
      expect(API_KEY_PLACEHOLDER).toBe("<your-api-key>");
      expect(commands.claudeCode).toBe(
        `claude mcp add --scope user --transport http excalight ${ORIGIN}/api/mcp --header "Authorization: Bearer <your-api-key>"`,
      );
      expect(commands.codex.split("\n")).toEqual([
        "export EXCALIGHT_API_KEY=<your-api-key>",
        `codex mcp add excalight --url ${ORIGIN}/api/mcp --bearer-token-env-var EXCALIGHT_API_KEY`,
      ]);
    }
  });

  it("describes granted access", () => {
    expect(describeAgentAccess(["drawings:read", "drawings:write"])).toBe(
      "read & write",
    );
    expect(describeAgentAccess(["drawings:read", "collections:read"])).toBe(
      "read-only",
    );
  });

  it("only accepts loopback http redirect URLs", () => {
    expect(isLoopbackRedirectUrl("http://localhost:4567/callback?code=x")).toBe(
      true,
    );
    expect(isLoopbackRedirectUrl("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isLoopbackRedirectUrl("http://[::1]:9000/cb")).toBe(true);
    for (const url of [
      "https://localhost/callback",
      "http://evil.example/callback",
      "http://localhost.evil.example/callback",
      "javascript:alert(1)",
      "/relative",
    ]) {
      expect(isLoopbackRedirectUrl(url), url).toBe(false);
    }
  });
});
