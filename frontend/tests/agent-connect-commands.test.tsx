import { describe, expect, it } from "vitest";
import {
  API_KEY_PLACEHOLDER,
  buildAgentCommands,
  getMcpUrl,
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

  it("fills in a freshly created key", () => {
    const commands = buildAgentCommands(ORIGIN, TOKEN);
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
      const commands = buildAgentCommands(ORIGIN, token);
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
});
