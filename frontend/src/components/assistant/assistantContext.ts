import { AGENT_CHAT_LIMITS, type AgentChatRequest } from "../../api/ai";

/** Name of the Excalidraw custom sidebar that hosts the assistant. */
export const ASSISTANT_SIDEBAR_NAME = "excalight-assistant";

type AppStateLike = {
  selectedElementIds?: Record<string, boolean> | null;
  scrollX?: number;
  scrollY?: number;
  width?: number;
  height?: number;
  zoom?: { value?: number } | null;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Per-request context for the assistant from Excalidraw's app state: the
 * selected element ids and the visible area in scene coordinates.
 */
export const buildAssistantContext = (
  appState: AppStateLike | null | undefined,
): AgentChatRequest["context"] => {
  if (!appState) return {};
  const selectedElementIds = Object.entries(appState.selectedElementIds ?? {})
    .filter(([, selected]) => selected)
    .map(([id]) => id)
    .slice(0, AGENT_CHAT_LIMITS.maxSelectedIds);
  const zoom = appState.zoom?.value;
  const { scrollX, scrollY, width, height } = appState;
  const context: AgentChatRequest["context"] = { selectedElementIds };
  if (
    isFiniteNumber(zoom) &&
    zoom > 0 &&
    isFiniteNumber(scrollX) &&
    isFiniteNumber(scrollY) &&
    isFiniteNumber(width) &&
    isFiniteNumber(height) &&
    width > 0 &&
    height > 0
  ) {
    context.viewport = {
      x: -scrollX,
      y: -scrollY,
      width: width / zoom,
      height: height / zoom,
      zoom,
    };
  }
  return context;
};
