/**
 * MCP adapter for the shared drawing tools (../tools/drawingTools.ts): the
 * same definitions also back the in-editor AI assistant.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { InternalApiClient } from "./internalApi";
import {
  DRAWING_TOOLS,
  ELEMENT_FORMAT_HELP,
  type DrawingToolContext,
  type DrawingToolResult,
} from "../tools/drawingTools";

export { drawingUrl, summarizeElements } from "../tools/drawingTools";

export type McpToolContext = {
  api: InternalApiClient;
  scopes: readonly string[];
  /** Public origin of the web app, e.g. https://excalidash.example.com */
  publicOrigin: string;
  serverVersion: string;
};

export const MCP_SERVER_INSTRUCTIONS = `Tools for reading and editing Excalidraw drawings stored in this whiteboard app. Use list_drawings to find a drawing, get_drawing to read its elements (always do this before update_drawing so you know the element ids and positions), create_drawing to start a new drawing and update_drawing to add, change or remove elements. Every result includes the browser URL of the drawing so the user can open it; edits appear live for people who have the drawing open.

${ELEMENT_FORMAT_HELP}`;

const toCallToolResult = (result: DrawingToolResult): CallToolResult => ({
  content: [{ type: "text", text: result.text }],
  ...(result.isError ? { isError: true } : {}),
});

export const registerMcpTools = (
  server: McpServer,
  context: McpToolContext,
) => {
  const toolContext: DrawingToolContext = {
    api: context.api,
    scopes: context.scopes,
    publicOrigin: context.publicOrigin,
  };
  for (const tool of DRAWING_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: tool.annotations,
      },
      async (input: any) =>
        toCallToolResult(await tool.handler(toolContext, input ?? {})),
    );
  }
};

export const createMcpServer = (context: McpToolContext): McpServer => {
  const server = new McpServer(
    { name: "excalidash", version: context.serverVersion },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  registerMcpTools(server, context);
  return server;
};
