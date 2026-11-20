// Commands shown in Settings > "Connect an AI agent" for registering this
// app's remote MCP server with coding agents, and helpers for the OAuth
// consent screen.

/** Name the MCP server is registered under in the agent's config. */
export const MCP_SERVER_NAME = "excalight";
export const AGENT_API_KEY_ENV_VAR = "EXCALIGHT_API_KEY";
export const API_KEY_PLACEHOLDER = "<your-api-key>";
export const AGENT_API_KEY_NAME = "AI agent (Claude Code / Codex)";
export const AGENT_READ_ONLY_API_KEY_NAME =
  "AI agent (Claude Code / Codex, read-only)";
export const AGENT_READ_ONLY_SCOPES = ["drawings:read", "collections:read"];

/** The nginx in front of the backend serves the API under /api. */
export const getMcpUrl = (origin: string): string =>
  `${origin.replace(/\/+$/, "")}/api/mcp`;

export type AgentCommands = {
  mcpUrl: string;
  claudeCode: string;
  codex: string;
};

/**
 * Primary path: register the server URL only; the agent then signs in through
 * the browser with OAuth (Claude Code: /mcp > Authenticate).
 */
export const buildAgentCommands = (origin: string): AgentCommands => {
  const mcpUrl = getMcpUrl(origin);
  return {
    mcpUrl,
    claudeCode: `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${mcpUrl}`,
    codex: [
      `codex mcp add ${MCP_SERVER_NAME} --url ${mcpUrl}`,
      `codex mcp login ${MCP_SERVER_NAME}`,
    ].join("\n"),
  };
};

/** Advanced fallback: a static API key sent as a Bearer header. */
export const buildApiKeyAgentCommands = (
  origin: string,
  token?: string | null,
): AgentCommands => {
  const mcpUrl = getMcpUrl(origin);
  const key = token?.trim() || API_KEY_PLACEHOLDER;
  return {
    mcpUrl,
    claudeCode: `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${mcpUrl} --header "Authorization: Bearer ${key}"`,
    codex: [
      `export ${AGENT_API_KEY_ENV_VAR}=${key}`,
      `codex mcp add ${MCP_SERVER_NAME} --url ${mcpUrl} --bearer-token-env-var ${AGENT_API_KEY_ENV_VAR}`,
    ].join("\n"),
  };
};

const WRITE_SCOPES = new Set(["drawings:write", "collections:write"]);

/** "read & write" or "read-only" for a granted scope list. */
export const describeAgentAccess = (scopes: readonly string[]): string =>
  scopes.some((scope) => WRITE_SCOPES.has(scope))
    ? "read & write"
    : "read-only";

export const OAUTH_SCOPE_LABELS: Record<string, string> = {
  "drawings:read": "View your drawings",
  "drawings:write": "Create, edit and delete your drawings",
  "collections:read": "View your collections",
  "collections:write": "Create, rename and delete your collections",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The consent screen only ever sends the browser back to the agent on this
 * computer (the server enforces the same rule; this is defense in depth).
 */
export const isLoopbackRedirectUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};
