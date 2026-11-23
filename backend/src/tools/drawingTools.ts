/**
 * Drawing tools shared by the remote MCP server (../mcp/tools.ts) and the
 * in-editor AI assistant (../ai/agent.ts): one definition per tool with its
 * name, description, zod input shape and handler. Handlers check the caller's
 * scopes and then call this backend's own REST API over loopback (see
 * ../mcp/internalApi.ts), so authentication, sharing rules, validation,
 * version conflicts, history snapshots and live broadcast all apply.
 *
 * There is deliberately no tool to delete a drawing or change its sharing.
 */
import { z } from "zod";
import {
  applyElementEdits,
  ElementInputError,
  MAX_ELEMENTS_PER_CALL,
  normalizeNewElements,
  SUPPORTED_ELEMENT_TYPES,
  type SceneElement,
} from "../mcp/elements";
import type {
  InternalApiClient,
  InternalApiResponse,
} from "../mcp/internalApi";

export type DrawingToolContext = {
  api: InternalApiClient;
  scopes: readonly string[];
  /** Public origin of the web app, e.g. https://excalidash.example.com */
  publicOrigin: string;
};

export type DrawingToolResult = {
  /** Full result for the model / MCP client. */
  text: string;
  isError?: boolean;
  /** Short human summary for activity lines, e.g. "Updated 5 elements". */
  summary: string;
  /** True when the tool saved a drawing (created or updated one). */
  changedDrawing?: boolean;
};

export type DrawingToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type DrawingToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> =
  {
    name: string;
    title: string;
    description: string;
    inputShape: Shape;
    annotations: DrawingToolAnnotations;
    handler: (
      context: DrawingToolContext,
      input: z.infer<z.ZodObject<Shape>>,
    ) => Promise<DrawingToolResult>;
  };

const defineTool = <Shape extends z.ZodRawShape>(
  definition: DrawingToolDefinition<Shape>,
): DrawingToolDefinition<Shape> => definition;

const MAX_LISTED_ELEMENTS = 500;
const MAX_TEXT_PREVIEW = 500;

export const drawingUrl = (publicOrigin: string, drawingId: string) =>
  `${publicOrigin}/editor/${encodeURIComponent(drawingId)}`;

export const ELEMENT_FORMAT_HELP = `Elements use the Excalidraw JSON format. Only "type" is required; ids, seed, version and other bookkeeping fields are filled in. Supported types: ${SUPPORTED_ELEMENT_TYPES.join(", ")}.
- Shapes (rectangle, ellipse, diamond): x, y, width, height (top-left origin, y grows downwards), strokeColor (default "#1e1e1e"), backgroundColor (default "transparent"), fillStyle ("solid" | "hachure" | "cross-hatch" | "zigzag"), strokeWidth (1, 2 or 4), strokeStyle ("solid" | "dashed" | "dotted"), roughness (0 = clean, 1 = sketchy), opacity (0-100).
- Labels: give a shape or arrow "label": "Text" (or { "text", "fontSize", "strokeColor" }); a centred, wrapped text element bound to it is created.
- text: x, y, text (use \\n for new lines), fontSize (default 20), fontFamily (5 = Excalifont hand-drawn default, 2 = Helvetica, 3 = Cascadia code), textAlign. Width/height are estimated.
- arrow / line: x, y and points relative to (x, y), e.g. [[0, 0], [200, 0]]. To connect shapes, give an arrow "startBinding": { "elementId": "<shape id>" } and "endBinding": { "elementId": "<shape id>" } (or "start": { "id" }, "end": { "id" }); if you omit x, y and points the arrow is drawn straight between the two shapes. startArrowhead / endArrowhead: null, "arrow", "triangle", "dot", "bar", ...
- Give your own short ids (e.g. "box-api") when other elements must reference them in the same call.
- Group with "groupIds": ["g1"], put inside a frame with "frameId". Colors are CSS hex values; a pleasant palette: "#a5d8ff", "#b2f2bb", "#ffec99", "#ffc9c9", "#d0bfff".
Lay elements out on a grid with generous spacing (e.g. 200px x 100px boxes, 80-120px gaps) so labels do not overlap.`;

const ok = (
  text: string,
  summary: string,
  changedDrawing = false,
): DrawingToolResult => ({
  text,
  summary,
  ...(changedDrawing ? { changedDrawing } : {}),
});
const toolError = (text: string, summary: string): DrawingToolResult => ({
  text,
  isError: true,
  summary,
});

const missingScope = (
  context: DrawingToolContext,
  scope: string,
  summary: string,
): DrawingToolResult | null =>
  context.scopes.includes(scope)
    ? null
    : toolError(
        `This API key does not have the "${scope}" scope, so this tool is not available. Create a key with that scope in Settings > API keys.`,
        summary,
      );

export const describeApiError = (
  response: InternalApiResponse,
  what: string,
): string => {
  const body = response.body ?? {};
  const message =
    typeof body.message === "string"
      ? body.message
      : typeof body.error === "string"
        ? body.error
        : "";
  if (response.status === 401) {
    return "The API key was rejected (invalid, revoked or expired).";
  }
  if (response.status === 403) {
    return `Not allowed to ${what}${message ? `: ${message}` : "."}`;
  }
  if (response.status === 404) {
    return `Could not ${what}: not found, or you do not have access to it.`;
  }
  if (response.status === 400 || response.status === 413) {
    const details = Array.isArray(body.details)
      ? ` Details: ${JSON.stringify(body.details).slice(0, 1500)}`
      : "";
    return `Could not ${what}: the server rejected the request${message ? ` (${message})` : ""}.${details}`;
  }
  if (response.status === 429) {
    return `Could not ${what}: rate limit exceeded, try again later.`;
  }
  return `Could not ${what} (HTTP ${response.status}${message ? `: ${message}` : ""}).`;
};

const round = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 10) / 10
    : value;

const truncate = (value: string, max = MAX_TEXT_PREVIEW) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

type CollectionSummary = { id: string; name: string };

const fetchCollections = async (
  context: DrawingToolContext,
): Promise<CollectionSummary[] | null> => {
  if (!context.scopes.includes("collections:read")) return null;
  const response = await context.api.request("GET", "/collections");
  if (!response.ok || !Array.isArray(response.body)) return null;
  return response.body
    .filter(
      (entry: any) =>
        entry && typeof entry.id === "string" && typeof entry.name === "string",
    )
    .map((entry: any) => ({ id: entry.id, name: entry.name }));
};

const sceneBounds = (elements: SceneElement[]) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of elements) {
    const x = Number(element.x);
    const y = Number(element.y);
    const width = Number(element.width) || 0;
    const height = Number(element.height) || 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  return Number.isFinite(minX)
    ? {
        minX: Math.round(minX),
        minY: Math.round(minY),
        maxX: Math.round(maxX),
        maxY: Math.round(maxY),
      }
    : null;
};

/** One compact JSON line per element, with labels folded into containers. */
export const summarizeElements = (
  elements: SceneElement[],
): { lines: string[]; total: number; truncated: boolean } => {
  const visible = elements.filter(
    (element) =>
      element && typeof element.id === "string" && !element.isDeleted,
  );
  const byId = new Map(visible.map((element) => [element.id, element]));
  const labelOf = new Map<string, SceneElement>();
  for (const element of visible) {
    if (element.type === "text" && element.containerId) {
      const container = byId.get(element.containerId);
      if (container) labelOf.set(container.id, element);
    }
  }
  const listed = visible.filter(
    (element) =>
      !(
        element.type === "text" &&
        element.containerId &&
        byId.has(element.containerId)
      ),
  );
  const lines = listed.slice(0, MAX_LISTED_ELEMENTS).map((element) => {
    const summary: Record<string, unknown> = {
      id: element.id,
      type: element.type,
      x: round(element.x),
      y: round(element.y),
      width: round(element.width),
      height: round(element.height),
    };
    if (element.type === "text" && typeof element.text === "string") {
      summary.text = truncate(element.originalText || element.text);
    }
    const label = labelOf.get(element.id);
    if (label) {
      summary.label = truncate(label.originalText || label.text || "");
      summary.labelId = label.id;
    }
    if (element.type === "arrow" || element.type === "line") {
      if (Array.isArray(element.points) && element.points.length <= 12) {
        summary.points = element.points.map((point: unknown) =>
          Array.isArray(point) ? point.map(round) : point,
        );
      } else if (Array.isArray(element.points)) {
        summary.pointCount = element.points.length;
      }
      if (element.startBinding?.elementId) {
        summary.start = element.startBinding.elementId;
      }
      if (element.endBinding?.elementId) {
        summary.end = element.endBinding.elementId;
      }
    }
    if (element.strokeColor && element.strokeColor !== "#1e1e1e") {
      summary.strokeColor = element.strokeColor;
    }
    if (element.backgroundColor && element.backgroundColor !== "transparent") {
      summary.backgroundColor = element.backgroundColor;
    }
    if (element.type === "frame" && element.name) summary.name = element.name;
    if (element.frameId) summary.frameId = element.frameId;
    if (Array.isArray(element.groupIds) && element.groupIds.length > 0) {
      summary.groupIds = element.groupIds;
    }
    if (element.link) summary.link = element.link;
    if (element.angle) summary.angle = round(element.angle);
    return JSON.stringify(summary);
  });
  return {
    lines,
    total: listed.length,
    truncated: listed.length > MAX_LISTED_ELEMENTS,
  };
};

const formatIds = (ids: string[], max = 200) =>
  ids.length > max
    ? `${ids.slice(0, max).join(", ")} … (+${ids.length - max} more)`
    : ids.join(", ");

const formatLabelIds = (labelIds: Record<string, string>) => {
  const entries = Object.entries(labelIds);
  if (entries.length === 0) return "";
  return `\nLabel text ids: ${entries
    .slice(0, 200)
    .map(([container, label]) => `${container} -> ${label}`)
    .join(", ")}`;
};

const elementInputHint = (
  error: unknown,
  summary: string,
): DrawingToolResult => {
  if (error instanceof ElementInputError) {
    return toolError(`Invalid elements: ${error.message}`, summary);
  }
  throw error;
};

const looseElementSchema = z
  .object({ type: z.string().optional(), id: z.string().optional() })
  .passthrough();

const listDrawings = defineTool({
  name: "list_drawings",
  title: "List drawings",
  description:
    'List the user\'s drawings, most recently updated first. Optionally filter by a name search and/or a collection. Returns id, name, collection, last update time and the browser URL of each drawing. Drawings in the Trash are excluded unless collectionId is "trash".',
  inputShape: {
    query: z
      .string()
      .max(200)
      .optional()
      .describe("Case-insensitive search on the drawing name."),
    collectionId: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Only drawings in this collection (ids from list_collections; "null" = not in any collection, "trash" = Trash).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of drawings to return (default 25)."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (context, { query, collectionId, limit }) => {
    const failed = "Could not list drawings";
    const denied = missingScope(context, "drawings:read", failed);
    if (denied) return denied;
    const params = new URLSearchParams({
      limit: String(limit ?? 25),
      sortField: "updatedAt",
      sortDirection: "desc",
    });
    if (query?.trim()) params.set("search", query.trim());
    if (collectionId) params.set("collectionId", collectionId);
    const [response, collections] = await Promise.all([
      context.api.request("GET", `/drawings?${params.toString()}`),
      fetchCollections(context),
    ]);
    if (!response.ok) {
      return toolError(describeApiError(response, "list drawings"), failed);
    }
    const drawings: any[] = Array.isArray(response.body?.drawings)
      ? response.body.drawings
      : [];
    const totalCount =
      typeof response.body?.totalCount === "number"
        ? response.body.totalCount
        : drawings.length;
    const collectionNames = new Map(
      (collections ?? []).map((entry) => [entry.id, entry.name]),
    );
    if (drawings.length === 0) {
      return ok(
        query || collectionId
          ? "No drawings match these filters."
          : "This account has no drawings yet. Use create_drawing to make one.",
        "No drawings found",
      );
    }
    const lines = drawings.map((drawing) =>
      JSON.stringify({
        id: drawing.id,
        name: drawing.name,
        collection: drawing.collectionId
          ? (collectionNames.get(drawing.collectionId) ?? drawing.collectionId)
          : null,
        collectionId: drawing.collectionId ?? null,
        updatedAt: drawing.updatedAt,
        url: drawingUrl(context.publicOrigin, drawing.id),
      }),
    );
    const more =
      totalCount > drawings.length
        ? ` Use query/collectionId or a higher limit to see the rest.`
        : "";
    return ok(
      `${drawings.length} of ${totalCount} drawings.${more}\n${lines.join("\n")}`,
      `Listed ${plural(drawings.length, "drawing")}`,
    );
  },
});

const listCollections = defineTool({
  name: "list_collections",
  title: "List collections",
  description:
    "List the collections (folders) the user owns or that are shared with them, with their ids. Use an id as collectionId in list_drawings or create_drawing.",
  inputShape: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (context) => {
    const failed = "Could not list collections";
    const denied = missingScope(context, "collections:read", failed);
    if (denied) return denied;
    const response = await context.api.request("GET", "/collections");
    if (!response.ok || !Array.isArray(response.body)) {
      return toolError(describeApiError(response, "list collections"), failed);
    }
    const lines = response.body.map((entry: any) =>
      JSON.stringify({
        id: entry.id,
        name: entry.name,
        ...(entry.isOwner === false
          ? { sharedWithYou: true, role: entry.sharedRole ?? "view" }
          : {}),
      }),
    );
    return ok(
      lines.length === 0
        ? "No collections."
        : `${lines.length} collections.\n${lines.join("\n")}`,
      `Listed ${plural(lines.length, "collection")}`,
    );
  },
});

const getDrawing = defineTool({
  name: "get_drawing",
  title: "Get drawing",
  description: `Read a drawing: name, browser URL, version and a compact list of its elements (id, type, position, size, text or label, arrow start/end bindings, colors). Text labels bound to shapes are shown as "label"/"labelId" on the shape. At most ${MAX_LISTED_ELEMENTS} elements are listed. Call this before update_drawing.`,
  inputShape: {
    id: z.string().min(1).max(200).describe("Drawing id."),
    includeElements: z
      .boolean()
      .optional()
      .describe("Include the element list (default true)."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (context, { id, includeElements }) => {
    const failed = "Could not read the drawing";
    const denied = missingScope(context, "drawings:read", failed);
    if (denied) return denied;
    const response = await context.api.request(
      "GET",
      `/drawings/${encodeURIComponent(id)}`,
    );
    if (!response.ok) {
      return toolError(
        describeApiError(response, `read drawing "${id}"`),
        failed,
      );
    }
    const drawing = response.body ?? {};
    const elements: SceneElement[] = Array.isArray(drawing.elements)
      ? drawing.elements
      : [];
    const visible = elements.filter((element) => element && !element.isDeleted);
    const bounds = sceneBounds(visible);
    const header = [
      `Drawing "${drawing.name}"`,
      `id: ${drawing.id} | url: ${drawingUrl(context.publicOrigin, drawing.id)}`,
      `version: ${drawing.version} | access: ${drawing.accessLevel ?? "unknown"} | updated: ${drawing.updatedAt}${drawing.collectionId ? ` | collectionId: ${drawing.collectionId}` : ""}`,
      `elements: ${visible.length}${bounds ? ` | bounds: x ${bounds.minX}..${bounds.maxX}, y ${bounds.minY}..${bounds.maxY}` : ""}`,
    ];
    const summary = `Read the drawing (${plural(visible.length, "element")})`;
    if (includeElements === false) return ok(header.join("\n"), summary);
    const listing = summarizeElements(elements);
    if (listing.total === 0) {
      return ok(`${header.join("\n")}\nThe drawing is empty.`, summary);
    }
    const note = listing.truncated
      ? `\nShowing the first ${MAX_LISTED_ELEMENTS} of ${listing.total} elements.`
      : "";
    return ok(
      `${header.join("\n")}\n${listing.lines.join("\n")}${note}`,
      summary,
    );
  },
});

const createDrawing = defineTool({
  name: "create_drawing",
  title: "Create drawing",
  description: `Create a new drawing from Excalidraw elements and return its id and browser URL. At most ${MAX_ELEMENTS_PER_CALL} elements per call; add more with update_drawing.\n\n${ELEMENT_FORMAT_HELP}`,
  inputShape: {
    name: z.string().trim().min(1).max(255).describe("Drawing name."),
    collectionId: z
      .string()
      .max(200)
      .optional()
      .describe("Collection to create the drawing in (see list_collections)."),
    elements: z
      .array(looseElementSchema)
      .max(MAX_ELEMENTS_PER_CALL)
      .describe("Excalidraw elements to draw."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (context, { name, collectionId, elements }) => {
    const failed = "Could not create the drawing";
    const denied = missingScope(context, "drawings:write", failed);
    if (denied) return denied;
    let normalized;
    try {
      normalized = normalizeNewElements(elements);
    } catch (error) {
      return elementInputHint(error, failed);
    }
    const response = await context.api.request("POST", "/drawings", {
      name,
      ...(collectionId ? { collectionId } : {}),
      elements: normalized.elements,
      appState: { viewBackgroundColor: "#ffffff" },
    });
    if (!response.ok || typeof response.body?.id !== "string") {
      return toolError(
        describeApiError(response, "create the drawing"),
        failed,
      );
    }
    const created = response.body;
    return ok(
      [
        `Created drawing "${created.name}".`,
        `id: ${created.id}`,
        `url: ${drawingUrl(context.publicOrigin, created.id)}`,
        `elements: ${normalized.addedIds.length}${normalized.addedIds.length ? ` (ids: ${formatIds(normalized.addedIds)})` : ""}${formatLabelIds(normalized.labelIds)}`,
      ].join("\n"),
      `Created drawing "${truncate(String(created.name), 60)}" with ${plural(normalized.addedIds.length, "element")}`,
      true,
    );
  },
});

const describeEdits = (added: number, updated: number, removed: number) => {
  const total = added + updated + removed;
  const parts = [
    added ? `added ${added}` : "",
    updated ? `changed ${updated}` : "",
    removed ? `removed ${removed}` : "",
  ].filter(Boolean);
  return parts.length > 1
    ? `Updated ${plural(total, "element")} (${parts.join(", ")})`
    : added
      ? `Added ${plural(added, "element")}`
      : removed
        ? `Removed ${plural(removed, "element")}`
        : `Updated ${plural(total, "element")}`;
};

const updateDrawing = defineTool({
  name: "update_drawing",
  title: "Update drawing",
  description: `Edit an existing drawing: add elements, change existing elements (partial objects with the element "id" and only the fields to change; "label" changes a shape's label text) and remove elements by id. Changes are applied to the latest saved version and appear live for anyone viewing it. Moving a shape re-routes straight arrows connected to it. Call get_drawing first to learn element ids.\n\n${ELEMENT_FORMAT_HELP}`,
  inputShape: {
    id: z.string().min(1).max(200).describe("Drawing id."),
    addElements: z
      .array(looseElementSchema)
      .max(MAX_ELEMENTS_PER_CALL)
      .optional()
      .describe("New Excalidraw elements."),
    updateElements: z
      .array(looseElementSchema.extend({ id: z.string().min(1) }))
      .max(MAX_ELEMENTS_PER_CALL)
      .optional()
      .describe(
        'Partial elements: { "id": "<existing id>", ...fields to change }.',
      ),
    removeElementIds: z
      .array(z.string().min(1).max(200))
      .max(MAX_ELEMENTS_PER_CALL)
      .optional()
      .describe("Ids of elements to delete (their labels are deleted too)."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (
    context,
    { id, addElements, updateElements, removeElementIds },
  ) => {
    const failed = "Could not update the drawing";
    const denied = missingScope(context, "drawings:write", failed);
    if (denied) return denied;
    if (
      !addElements?.length &&
      !updateElements?.length &&
      !removeElementIds?.length
    ) {
      return toolError(
        "Nothing to do: pass addElements, updateElements and/or removeElementIds.",
        failed,
      );
    }
    if (!context.scopes.includes("drawings:read")) {
      return toolError(
        'update_drawing also needs the "drawings:read" scope to load the current scene.',
        failed,
      );
    }
    const path = `/drawings/${encodeURIComponent(id)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await context.api.request("GET", path);
      if (!current.ok) {
        return toolError(
          describeApiError(current, `read drawing "${id}"`),
          failed,
        );
      }
      const drawing = current.body ?? {};
      if (drawing.accessLevel === "view") {
        return toolError(
          `You only have view access to drawing "${drawing.name}", so it cannot be edited.`,
          failed,
        );
      }
      let result;
      try {
        result = applyElementEdits(
          Array.isArray(drawing.elements) ? drawing.elements : [],
          { addElements, updateElements, removeElementIds },
        );
      } catch (error) {
        return elementInputHint(error, failed);
      }
      const saved = await context.api.request("PUT", path, {
        elements: result.elements,
        version: drawing.version,
      });
      if (saved.status === 409) continue;
      if (!saved.ok) {
        return toolError(
          describeApiError(saved, `save drawing "${id}"`),
          failed,
        );
      }
      const lines = [
        `Updated drawing "${saved.body?.name ?? drawing.name}" (now version ${saved.body?.version ?? "?"}).`,
        `url: ${drawingUrl(context.publicOrigin, id)}`,
        `added: ${result.addedIds.length}${result.addedIds.length ? ` (ids: ${formatIds(result.addedIds)})` : ""}`,
        `updated: ${result.updatedIds.length}`,
        `removed: ${result.removedIds.length}`,
      ];
      return ok(
        lines.join("\n") + formatLabelIds(result.labelIds),
        describeEdits(
          result.addedIds.length,
          result.updatedIds.length,
          result.removedIds.length,
        ),
        true,
      );
    }
    return toolError(
      "The drawing was changed by someone else while saving, twice in a row. Nothing was saved; call get_drawing and try again.",
      failed,
    );
  },
});

/** Every drawing tool, in a fixed order (keeps the prompt prefix cache-stable). */
export const DRAWING_TOOLS: readonly DrawingToolDefinition<any>[] = [
  listDrawings,
  listCollections,
  getDrawing,
  createDrawing,
  updateDrawing,
];
