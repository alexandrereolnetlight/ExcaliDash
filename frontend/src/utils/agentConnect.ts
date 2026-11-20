// Commands shown in Settings > "Connect an AI agent" for registering this
// app's remote MCP server with coding agents.

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

export const buildAgentCommands = (
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
