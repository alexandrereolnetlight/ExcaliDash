/**
 * Element normalisation for the MCP tools.
 *
 * Language models write Excalidraw element JSON loosely: bookkeeping fields
 * (seed, version, versionNonce, ...) are usually missing, labels are written
 * as `label`/`text` on shapes, and arrow bindings only name the target. This
 * module turns that input into complete Excalidraw 0.18 elements, keeps the
 * label (containerId/boundElements) and arrow-binding links consistent across
 * the whole scene, and bumps version/versionNonce on every element it changes
 * so open editors accept the result when the saved scene is broadcast.
 */
import crypto from "crypto";
import { MAX_ELEMENT_TEXT_LENGTH } from "../security";

export type SceneElement = Record<string, any> & { id: string; type: string };

export class ElementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElementInputError";
  }
}

export const MAX_ELEMENTS_PER_CALL = 2000;
export const SUPPORTED_ELEMENT_TYPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "text",
  "freedraw",
  "frame",
] as const;

const SUPPORTED_TYPES = new Set<string>(SUPPORTED_ELEMENT_TYPES);
const CONTAINER_TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow"]);
const BINDABLE_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "frame",
  "magicframe",
  "image",
  "iframe",
  "embeddable",
]);
const LINEAR_TYPES = new Set(["line", "arrow"]);

const MAX_POINTS = 5000;
const MAX_ELEMENT_JSON_CHARS = 256 * 1024;
const MAX_CUSTOM_DATA_CHARS = 16 * 1024;
const MAX_GROUP_IDS = 32;
const MAX_BOUND_ELEMENTS = 500;
const COORD_LIMIT = 10_000_000;
const SIZE_LIMIT = 1_000_000;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

// Excalidraw 0.18 defaults (DEFAULT_ELEMENT_PROPS, DEFAULT_FONT_*).
export const DEFAULT_STROKE_COLOR = "#1e1e1e";
export const DEFAULT_BACKGROUND_COLOR = "transparent";
export const DEFAULT_FONT_SIZE = 20;
// FONT_FAMILY.Excalifont: Excalidraw's (and therefore the app's) default.
export const DEFAULT_FONT_FAMILY = 5;
const DEFAULT_LINE_HEIGHT = 1.25;
const BOUND_TEXT_PADDING = 5;
const BINDING_GAP = 5;
// Rough average glyph width as a fraction of the font size. Excalidraw
// measures text with the real font when it is edited; this is only used to
// size new text so it renders close to right on first load.
const CHAR_WIDTH_FACTOR = 0.6;

const FONT_FAMILIES: Record<string, number> = {
  virgil: 1,
  helvetica: 2,
  cascadia: 3,
  excalifont: 5,
  nunito: 6,
  "lilita one": 7,
  "comic shanns": 8,
  "liberation sans": 9,
};
const FONT_LINE_HEIGHTS: Record<number, number> = {
  1: 1.25,
  2: 1.15,
  3: 1.2,
  5: 1.25,
  6: 1.35,
  7: 1.15,
  8: 1.25,
  9: 1.15,
};
const FILL_STYLES = ["hachure", "cross-hatch", "solid", "zigzag"];
const STROKE_STYLES = ["solid", "dashed", "dotted"];
const TEXT_ALIGNS = ["left", "center", "right"];
const VERTICAL_ALIGNS = ["top", "middle", "bottom"];
const ARROWHEADS = [
  "arrow",
  "bar",
  "dot",
  "circle",
  "circle_outline",
  "triangle",
  "triangle_outline",
  "diamond",
  "diamond_outline",
  "crowfoot_one",
  "crowfoot_many",
  "crowfoot_one_or_many",
];

const BASE_KEYS = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "seed",
  "version",
  "versionNonce",
  "index",
  "isDeleted",
  "groupIds",
  "frameId",
  "boundElements",
  "updated",
  "link",
  "locked",
  "customData",
];
const TYPE_KEYS: Record<string, string[]> = {
  text: [
    "text",
    "fontSize",
    "fontFamily",
    "textAlign",
    "verticalAlign",
    "containerId",
    "originalText",
    "autoResize",
    "lineHeight",
  ],
  line: [
    "points",
    "lastCommittedPoint",
    "startBinding",
    "endBinding",
    "startArrowhead",
    "endArrowhead",
  ],
  arrow: [
    "points",
    "lastCommittedPoint",
    "startBinding",
    "endBinding",
    "startArrowhead",
    "endArrowhead",
    "elbowed",
  ],
  freedraw: ["points", "pressures", "simulatePressure", "lastCommittedPoint"],
  frame: ["name"],
};
// Fields the server owns on updates; values sent by the caller are ignored.
const SERVER_OWNED_ON_UPDATE = new Set([
  "id",
  "type",
  "seed",
  "version",
  "versionNonce",
  "index",
  "updated",
]);
const GEOMETRY_KEYS = ["x", "y", "width", "height", "angle", "points"];

export const randomElementId = (): string =>
  crypto.randomBytes(15).toString("base64url");
const randomInteger = (): number => crypto.randomInt(1, 2 ** 31 - 1);

const isPlainObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describeElement = (
  el: { id?: unknown; type?: unknown },
  index?: number,
) => {
  const parts: string[] = [];
  if (index !== undefined) parts.push(`#${index}`);
  if (typeof el.type === "string") parts.push(el.type);
  if (typeof el.id === "string") parts.push(`"${el.id}"`);
  return `Element ${parts.join(" ")}`.trim();
};

const finiteNumber = (
  value: unknown,
  field: string,
  where: string,
  min: number,
  max: number,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ElementInputError(
      `${where}: "${field}" must be a finite number.`,
    );
  }
  if (value < min || value > max) {
    throw new ElementInputError(
      `${where}: "${field}" must be between ${min} and ${max}.`,
    );
  }
  return value;
};

const shortString = (
  value: unknown,
  field: string,
  where: string,
  maxLength: number,
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ElementInputError(`${where}: "${field}" must be a string.`);
  }
  if (value.length > maxLength) {
    throw new ElementInputError(
      `${where}: "${field}" must be at most ${maxLength} characters.`,
    );
  }
  return value;
};

const enumValue = (
  value: unknown,
  field: string,
  where: string,
  allowed: readonly string[],
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ElementInputError(
      `${where}: "${field}" must be one of ${allowed.join(", ")}.`,
    );
  }
  return value;
};

const booleanValue = (
  value: unknown,
  field: string,
  where: string,
): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ElementInputError(`${where}: "${field}" must be a boolean.`);
  }
  return value;
};

const elementId = (
  value: unknown,
  field: string,
  where: string,
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ElementInputError(
      `${where}: "${field}" must be 1-100 characters of letters, digits, "_", "-", ".", ":".`,
    );
  }
  return value;
};

const parseFontFamily = (value: unknown, where: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && FONT_LINE_HEIGHTS[value] !== undefined) {
    return value;
  }
  if (typeof value === "string") {
    const mapped = FONT_FAMILIES[value.trim().toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  throw new ElementInputError(
    `${where}: "fontFamily" must be one of 1 (Virgil), 2 (Helvetica), 3 (Cascadia), 5 (Excalifont, default), 6 (Nunito), 7 (Lilita One), 8 (Comic Shanns), 9 (Liberation Sans).`,
  );
};

const parseRoundness = (
  value: unknown,
  type: string,
  where: string,
): { type: number; value?: number } | null => {
  if (value === null || value === "sharp") return null;
  if (value === "round") return defaultRoundness(type) ?? { type: 3 };
  if (!isPlainObject(value)) {
    throw new ElementInputError(
      `${where}: "roundness" must be null, "sharp", "round" or { "type": 1 | 2 | 3 }.`,
    );
  }
  const roundnessType = value.type;
  if (roundnessType !== 1 && roundnessType !== 2 && roundnessType !== 3) {
    throw new ElementInputError(
      `${where}: "roundness.type" must be 1, 2 or 3.`,
    );
  }
  const roundnessValue = finiteNumber(
    value.value,
    "roundness.value",
    where,
    0,
    SIZE_LIMIT,
  );
  return roundnessValue === undefined
    ? { type: roundnessType }
    : { type: roundnessType, value: roundnessValue };
};

const defaultRoundness = (type: string): { type: number } | null => {
  if (type === "rectangle") return { type: 3 };
  if (type === "diamond" || type === "line" || type === "arrow") {
    return { type: 2 };
  }
  return null;
};

const parsePoints = (
  value: unknown,
  field: string,
  where: string,
  minPoints: number,
): [number, number][] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ElementInputError(
      `${where}: "${field}" must be an array of [x, y] pairs.`,
    );
  }
  if (value.length < minPoints || value.length > MAX_POINTS) {
    throw new ElementInputError(
      `${where}: "${field}" must contain between ${minPoints} and ${MAX_POINTS} points.`,
    );
  }
  return value.map((point, index) => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !point.every(
        (coord) =>
          typeof coord === "number" &&
          Number.isFinite(coord) &&
          Math.abs(coord) <= COORD_LIMIT,
      )
    ) {
      throw new ElementInputError(
        `${where}: "${field}[${index}]" must be a pair of finite numbers [x, y].`,
      );
    }
    return [point[0], point[1]] as [number, number];
  });
};

const parseBinding = (
  value: unknown,
  field: string,
  where: string,
): { elementId: string; focus: number; gap: number } | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const target: Record<string, any> | null =
    typeof value === "string"
      ? { elementId: value }
      : isPlainObject(value)
        ? { ...value, elementId: value.elementId ?? value.id }
        : null;
  if (!target) {
    throw new ElementInputError(
      `${where}: "${field}" must be { "elementId": "<id>" } or null.`,
    );
  }
  const id = elementId(target.elementId, `${field}.elementId`, where);
  if (!id) {
    throw new ElementInputError(
      `${where}: "${field}" must name the bound element with "elementId".`,
    );
  }
  return {
    elementId: id,
    focus: finiteNumber(target.focus, `${field}.focus`, where, -1, 1) ?? 0,
    gap:
      finiteNumber(target.gap, `${field}.gap`, where, 0, 1000) ?? BINDING_GAP,
  };
};

const parseCustomData = (value: unknown, where: string) => {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new ElementInputError(`${where}: "customData" must be an object.`);
  }
  if (JSON.stringify(value).length > MAX_CUSTOM_DATA_CHARS) {
    throw new ElementInputError(
      `${where}: "customData" is larger than ${MAX_CUSTOM_DATA_CHARS} characters.`,
    );
  }
  return value;
};

const parseGroupIds = (value: unknown, where: string): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_GROUP_IDS) {
    throw new ElementInputError(
      `${where}: "groupIds" must be an array of at most ${MAX_GROUP_IDS} ids.`,
    );
  }
  return value.map((groupId, index) => {
    const parsed = elementId(groupId, `groupIds[${index}]`, where);
    if (!parsed) {
      throw new ElementInputError(
        `${where}: "groupIds[${index}]" must be an id string.`,
      );
    }
    return parsed;
  });
};

const parseBoundElements = (
  value: unknown,
  where: string,
): { id: string; type: "arrow" | "text" }[] | null => {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_BOUND_ELEMENTS) {
    throw new ElementInputError(
      `${where}: "boundElements" must be null or an array of { "id", "type": "arrow" | "text" }.`,
    );
  }
  return value.map((entry, index) => {
    const id = isPlainObject(entry)
      ? elementId(entry.id, `boundElements[${index}].id`, where)
      : undefined;
    if (!id || (entry.type !== "arrow" && entry.type !== "text")) {
      throw new ElementInputError(
        `${where}: "boundElements[${index}]" must be { "id", "type": "arrow" | "text" }.`,
      );
    }
    return { id, type: entry.type };
  });
};

const textLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

export const estimateTextSize = (
  text: string,
  fontSize: number,
  lineHeight: number,
): { width: number; height: number } => {
  const lines = textLines(text);
  const longest = lines.reduce(
    (max, line) => Math.max(max, Array.from(line).length),
    0,
  );
  return {
    width: Math.max(1, Math.ceil(longest * fontSize * CHAR_WIDTH_FACTOR)),
    height: Math.ceil(lines.length * fontSize * lineHeight),
  };
};

/** Greedy word wrap using the same width estimate as {@link estimateTextSize}. */
export const wrapText = (
  text: string,
  fontSize: number,
  maxWidth: number,
): string => {
  const maxChars = Math.max(
    1,
    Math.floor(maxWidth / (fontSize * CHAR_WIDTH_FACTOR)),
  );
  const wrapped: string[] = [];
  for (const paragraph of textLines(text)) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      let rest = word;
      while (Array.from(rest).length > maxChars) {
        if (line) {
          wrapped.push(line);
          line = "";
        }
        const chars = Array.from(rest);
        wrapped.push(chars.slice(0, maxChars).join(""));
        rest = chars.slice(maxChars).join("");
      }
      if (!line) {
        line = rest;
      } else if (
        Array.from(line).length + 1 + Array.from(rest).length <=
        maxChars
      ) {
        line = `${line} ${rest}`;
      } else {
        wrapped.push(line);
        line = rest;
      }
    }
    wrapped.push(line);
  }
  return wrapped.join("\n");
};

const pickKnownKeys = (
  raw: Record<string, any>,
  type: string,
): Record<string, any> => {
  const allowed = new Set([...BASE_KEYS, ...(TYPE_KEYS[type] ?? [])]);
  const picked: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (allowed.has(key)) picked[key] = value;
  }
  return picked;
};

const checkPayloadSize = (raw: unknown, where: string) => {
  let size: number;
  try {
    size = JSON.stringify(raw)?.length ?? 0;
  } catch {
    throw new ElementInputError(`${where}: element is not valid JSON.`);
  }
  if (size > MAX_ELEMENT_JSON_CHARS) {
    throw new ElementInputError(
      `${where}: element is larger than ${MAX_ELEMENT_JSON_CHARS} characters.`,
    );
  }
};

const pointsBounds = (points: [number, number][]) => {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

/**
 * Validate one element (merged with `base` for updates) and fill every field
 * Excalidraw expects. Pure: does not look at other elements.
 */
const completeElement = (
  input: Record<string, any>,
  where: string,
  base?: SceneElement,
): SceneElement => {
  const type = input.type as string;
  const merged: Record<string, any> = base
    ? { ...base, ...input, type: base.type, id: base.id }
    : input;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  // Untouched fields of an existing element are kept verbatim (older scenes
  // may hold values this module would not accept as input); fields sent by
  // the caller are validated.
  const field = <T>(
    key: string,
    parse: (raw: unknown) => T | undefined,
    fallback: () => T,
  ): T => {
    if (base && !has(key) && base[key] !== undefined) {
      return base[key] ?? fallback();
    }
    return parse(merged[key]) ?? fallback();
  };
  const num = (
    key: string,
    min: number,
    max: number,
    fallback: () => number,
  ): number =>
    field(key, (raw) => finiteNumber(raw, key, where, min, max), fallback);

  const element: SceneElement = {
    id: field(
      "id",
      (raw) => elementId(raw, "id", where),
      () => randomElementId(),
    ),
    type,
    x: num("x", -COORD_LIMIT, COORD_LIMIT, () => 0),
    y: num("y", -COORD_LIMIT, COORD_LIMIT, () => 0),
    width: num("width", 0, SIZE_LIMIT, () => 0),
    height: num("height", 0, SIZE_LIMIT, () => 0),
    angle: num("angle", -COORD_LIMIT, COORD_LIMIT, () => 0),
    strokeColor: field(
      "strokeColor",
      (raw) => shortString(raw, "strokeColor", where, 64),
      () => DEFAULT_STROKE_COLOR,
    ),
    backgroundColor: field(
      "backgroundColor",
      (raw) => shortString(raw, "backgroundColor", where, 64),
      () => DEFAULT_BACKGROUND_COLOR,
    ),
    fillStyle: field(
      "fillStyle",
      (raw) => enumValue(raw, "fillStyle", where, FILL_STYLES),
      () => "solid",
    ),
    strokeWidth: num("strokeWidth", 0, 100, () => 2),
    strokeStyle: field(
      "strokeStyle",
      (raw) => enumValue(raw, "strokeStyle", where, STROKE_STYLES),
      () => "solid",
    ),
    roughness: num("roughness", 0, 10, () => 1),
    opacity: num("opacity", 0, 100, () => 100),
    roundness: has("roundness")
      ? parseRoundness(input.roundness, type, where)
      : base
        ? (base.roundness ?? null)
        : defaultRoundness(type),
    seed: num("seed", 0, 2 ** 31, randomInteger),
    version: Math.floor(num("version", 1, 2 ** 31, () => 1)),
    versionNonce: num("versionNonce", 0, 2 ** 31, randomInteger),
    index:
      typeof merged.index === "string" && merged.index.length <= 100
        ? merged.index
        : null,
    isDeleted: field(
      "isDeleted",
      (raw) => booleanValue(raw, "isDeleted", where),
      () => false,
    ),
    groupIds: field(
      "groupIds",
      (raw) => parseGroupIds(raw, where),
      () => [],
    ),
    frameId: field<string | null>(
      "frameId",
      (raw) => elementId(raw, "frameId", where),
      () => null,
    ),
    boundElements: field(
      "boundElements",
      (raw) => parseBoundElements(raw, where),
      () => null,
    ),
    updated: num("updated", 0, 8.64e15, () => Date.now()),
    link: field<string | null>(
      "link",
      (raw) => shortString(raw, "link", where, 2048),
      () => null,
    ),
    locked: field(
      "locked",
      (raw) => booleanValue(raw, "locked", where),
      () => false,
    ),
  };
  const customData = field(
    "customData",
    (raw) => parseCustomData(raw, where),
    () => undefined,
  );
  if (customData) element.customData = customData;

  if (type === "text") {
    const text = shortString(
      merged.text,
      "text",
      where,
      MAX_ELEMENT_TEXT_LENGTH,
    );
    if (text === undefined || text.trim().length === 0) {
      throw new ElementInputError(`${where}: text elements need a "text".`);
    }
    const containerId = field<string | null>(
      "containerId",
      (raw) => elementId(raw, "containerId", where),
      () => null,
    );
    const fontSize = num("fontSize", 1, 500, () => DEFAULT_FONT_SIZE);
    const fontFamily = field(
      "fontFamily",
      (raw) => parseFontFamily(raw, where),
      () => DEFAULT_FONT_FAMILY,
    );
    const lineHeight = field(
      "lineHeight",
      (raw) => finiteNumber(raw, "lineHeight", where, 0.5, 5),
      () => FONT_LINE_HEIGHTS[fontFamily] ?? DEFAULT_LINE_HEIGHT,
    );
    element.text = text;
    element.fontSize = fontSize;
    element.fontFamily = fontFamily;
    element.textAlign = field(
      "textAlign",
      (raw) => enumValue(raw, "textAlign", where, TEXT_ALIGNS),
      () => (containerId ? "center" : "left"),
    );
    element.verticalAlign = field(
      "verticalAlign",
      (raw) => enumValue(raw, "verticalAlign", where, VERTICAL_ALIGNS),
      () => (containerId ? "middle" : "top"),
    );
    element.containerId = containerId;
    element.originalText =
      (!base || has("text")) && !has("originalText")
        ? text
        : field(
            "originalText",
            (raw) =>
              shortString(raw, "originalText", where, MAX_ELEMENT_TEXT_LENGTH),
            () => text,
          );
    element.autoResize = field(
      "autoResize",
      (raw) => booleanValue(raw, "autoResize", where),
      () => true,
    );
    element.lineHeight = lineHeight;
    const metricsChanged =
      !base || has("text") || has("fontSize") || has("fontFamily");
    const sizeGiven =
      (has("width") || has("height")) &&
      element.width > 0 &&
      element.height > 0;
    if ((metricsChanged && !sizeGiven) || !element.width || !element.height) {
      const size = estimateTextSize(text, fontSize, lineHeight);
      element.width = size.width;
      element.height = size.height;
    }
  } else if (type === "line" || type === "arrow") {
    let points = parsePoints(merged.points, "points", where, 2);
    if (!points) {
      points = [
        [0, 0],
        [element.width || 100, element.height || 0],
      ];
    }
    // Excalidraw expects the first point at the element origin.
    const [originX, originY] = points[0];
    if (originX !== 0 || originY !== 0) {
      element.x += originX;
      element.y += originY;
      points = points.map(
        ([px, py]) => [px - originX, py - originY] as [number, number],
      );
    }
    const bounds = pointsBounds(points);
    element.points = points;
    element.width = bounds.width;
    element.height = bounds.height;
    element.lastCommittedPoint = null;
    const isArrow = type === "arrow";
    const binding = (key: string) =>
      isArrow
        ? field(
            key,
            (raw) => parseBinding(raw, key, where) ?? undefined,
            () => null,
          )
        : null;
    element.startBinding = binding("startBinding");
    element.endBinding = binding("endBinding");
    const arrowhead = (key: string, fallback: string | null) =>
      field<string | null>(
        key,
        (raw) => enumValue(raw, key, where, ARROWHEADS),
        () => fallback,
      );
    element.startArrowhead = arrowhead("startArrowhead", null);
    element.endArrowhead = arrowhead(
      "endArrowhead",
      isArrow && !base && !has("endArrowhead") ? "arrow" : null,
    );
    if (isArrow) {
      // Elbow arrows need fixed-point bindings and segment data that cannot
      // be derived reliably here; always store a plain arrow.
      element.elbowed = false;
    }
  } else if (type === "freedraw") {
    let points = parsePoints(merged.points, "points", where, 1) ?? [[0, 0]];
    const [originX, originY] = points[0];
    if (originX !== 0 || originY !== 0) {
      element.x += originX;
      element.y += originY;
      points = points.map(
        ([px, py]) => [px - originX, py - originY] as [number, number],
      );
    }
    const pressures = Array.isArray(merged.pressures)
      ? merged.pressures
      : undefined;
    const validPressures =
      pressures &&
      pressures.length === points.length &&
      pressures.every(
        (value: unknown) => typeof value === "number" && Number.isFinite(value),
      )
        ? (pressures as number[])
        : [];
    const bounds = pointsBounds(points);
    element.points = points;
    element.pressures = validPressures;
    element.simulatePressure = field(
      "simulatePressure",
      (raw) => booleanValue(raw, "simulatePressure", where),
      () => validPressures.length === 0,
    );
    element.lastCommittedPoint = null;
    element.width = bounds.width;
    element.height = bounds.height;
  } else if (type === "frame") {
    element.name = field<string | null>(
      "name",
      (raw) => shortString(raw, "name", where, 200),
      () => null,
    );
    if (!element.width) element.width = 400;
    if (!element.height) element.height = 300;
  } else {
    if (!element.width) element.width = 100;
    if (!element.height) element.height = 100;
  }
  return element;
};

type LabelSpec = {
  text: string;
  props: Record<string, any>;
};

const parseLabel = (
  raw: Record<string, any>,
  type: string,
  where: string,
): LabelSpec | null | undefined => {
  let value = raw.label;
  // Models often put the label text straight on the shape.
  if (value === undefined && type !== "text" && typeof raw.text === "string") {
    value = raw.text;
  }
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!CONTAINER_TYPES.has(type)) {
    throw new ElementInputError(
      `${where}: only rectangle, ellipse, diamond and arrow elements can have a label.`,
    );
  }
  if (typeof value === "string") return { text: value, props: {} };
  if (isPlainObject(value) && typeof value.text === "string") {
    const { text, ...props } = value;
    return { text, props };
  }
  throw new ElementInputError(
    `${where}: "label" must be a string or { "text": "...", "fontSize"?, "strokeColor"?, ... }.`,
  );
};

const LABEL_PROP_KEYS = [
  "fontSize",
  "fontFamily",
  "strokeColor",
  "textAlign",
  "verticalAlign",
  "opacity",
  "lineHeight",
];

const parseShorthandBinding = (
  raw: Record<string, any>,
  key: "start" | "end",
  where: string,
) => {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  const id =
    typeof value === "string"
      ? value
      : isPlainObject(value)
        ? (value.id ?? value.elementId)
        : undefined;
  if (typeof id !== "string") {
    throw new ElementInputError(
      `${where}: "${key}" must reference an existing element as { "id": "<elementId>" }.`,
    );
  }
  return { elementId: id };
};

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export type ElementEdits = {
  addElements?: unknown[];
  updateElements?: unknown[];
  removeElementIds?: string[];
};

export type ElementEditResult = {
  elements: SceneElement[];
  /** Ids of the added elements, in input order (labels excluded). */
  addedIds: string[];
  /** Label text element ids created for containers, keyed by container id. */
  labelIds: Record<string, string>;
  updatedIds: string[];
  removedIds: string[];
  /** Existing elements whose version was bumped (includes cascades). */
  changedCount: number;
};

/**
 * Apply MCP edits to a scene. `existing` is the latest saved scene; it is
 * never mutated. Throws {@link ElementInputError} with an LLM-readable message
 * on invalid input.
 */
export const applyElementEdits = (
  existing: readonly unknown[],
  edits: ElementEdits,
  options: { now?: number } = {},
): ElementEditResult => {
  const now = options.now ?? Date.now();
  const addInput = edits.addElements ?? [];
  const updateInput = edits.updateElements ?? [];
  const removeInput = edits.removeElementIds ?? [];
  if (!Array.isArray(addInput) || !Array.isArray(updateInput)) {
    throw new ElementInputError("Element lists must be arrays.");
  }
  if (!Array.isArray(removeInput)) {
    throw new ElementInputError("removeElementIds must be an array of ids.");
  }
  const total = addInput.length + updateInput.length + removeInput.length;
  if (total > MAX_ELEMENTS_PER_CALL) {
    throw new ElementInputError(
      `Too many elements in one call (${total}); the limit is ${MAX_ELEMENTS_PER_CALL}.`,
    );
  }

  const original = new Map<string, SceneElement>();
  const order: string[] = [];
  const scene = new Map<string, SceneElement>();
  for (const candidate of existing) {
    if (!isPlainObject(candidate) || typeof candidate.id !== "string") continue;
    if (scene.has(candidate.id)) continue;
    const copy = structuredClone(candidate) as SceneElement;
    original.set(copy.id, candidate as SceneElement);
    scene.set(copy.id, copy);
    order.push(copy.id);
  }

  const touched = new Set<string>();
  const geometryChanged = new Set<string>();
  const explicitPosition = new Set<string>();
  const addedIds: string[] = [];
  const labelIds: Record<string, string> = {};
  const updatedIds: string[] = [];
  const removedIds: string[] = [];

  const live = (id: string | null | undefined) => {
    if (!id) return undefined;
    const element = scene.get(id);
    return element && !element.isDeleted ? element : undefined;
  };
  const insert = (element: SceneElement) => {
    scene.set(element.id, element);
    order.push(element.id);
    touched.add(element.id);
  };
  const boundTextOf = (container: SceneElement) => {
    for (const entry of container.boundElements ?? []) {
      if (entry?.type !== "text") continue;
      const text = live(entry.id);
      if (text && text.containerId === container.id) return text;
    }
    for (const id of order) {
      const text = live(id);
      if (text?.type === "text" && text.containerId === container.id) {
        return text;
      }
    }
    return undefined;
  };
  const removeBoundEntry = (target: SceneElement, id: string) => {
    if (!Array.isArray(target.boundElements)) return;
    const next = target.boundElements.filter(
      (entry: { id?: string }) => entry?.id !== id,
    );
    if (next.length !== target.boundElements.length) {
      target.boundElements = next.length > 0 ? next : null;
    }
  };
  const addBoundEntry = (
    target: SceneElement,
    id: string,
    type: "arrow" | "text",
  ) => {
    const entries = Array.isArray(target.boundElements)
      ? target.boundElements
      : [];
    if (entries.some((entry: { id?: string }) => entry?.id === id)) return;
    target.boundElements = [...entries, { id, type }];
  };
  const makeLabel = (
    container: SceneElement,
    label: LabelSpec,
    where: string,
  ): SceneElement => {
    const props: Record<string, any> = {};
    for (const key of LABEL_PROP_KEYS) {
      if (label.props[key] !== undefined) props[key] = label.props[key];
    }
    const text = completeElement(
      {
        type: "text",
        text: label.text,
        strokeColor: container.strokeColor,
        ...props,
        containerId: container.id,
        groupIds: container.groupIds,
        frameId: container.frameId,
        locked: container.locked,
      },
      `${where} label`,
    );
    labelIds[container.id] = text.id;
    return text;
  };

  // 1. Removals (cascading like Excalidraw does when deleting in the UI).
  const removeOne = (id: string) => {
    const element = scene.get(id);
    if (!element || element.isDeleted) return;
    element.isDeleted = true;
    touched.add(id);
    if (element.type === "text" && element.containerId) {
      const container = scene.get(element.containerId);
      if (container) removeBoundEntry(container, id);
    }
    for (const entry of element.boundElements ?? []) {
      const other = scene.get(entry?.id);
      if (!other || other.isDeleted) continue;
      if (other.type === "text" && other.containerId === id) {
        removeOne(other.id);
      }
    }
    for (const binding of ["startBinding", "endBinding"]) {
      const targetId = element[binding]?.elementId;
      const target = targetId ? scene.get(targetId) : undefined;
      if (target) removeBoundEntry(target, id);
    }
    for (const otherId of order) {
      const other = scene.get(otherId)!;
      if (other.isDeleted) continue;
      if (other.startBinding?.elementId === id) other.startBinding = null;
      if (other.endBinding?.elementId === id) other.endBinding = null;
      if (other.frameId === id) other.frameId = null;
      if (other.type === "text" && other.containerId === id) {
        removeOne(other.id);
      }
    }
  };
  const removeSet = new Set<string>();
  removeInput.forEach((id, index) => {
    if (typeof id !== "string" || !scene.has(id)) {
      throw new ElementInputError(
        `removeElementIds[${index}]: no element with id ${JSON.stringify(id)} exists in this drawing.`,
      );
    }
    removeSet.add(id);
  });
  for (const id of removeSet) {
    removeOne(id);
    removedIds.push(id);
  }

  // 2. Updates (partial objects merged into the current element).
  const labelUpdates: { container: SceneElement; label: LabelSpec | null }[] =
    [];
  const updatedSet = new Set<string>();
  updateInput.forEach((raw, index) => {
    const where = describeElement(isPlainObject(raw) ? raw : {}, index);
    if (!isPlainObject(raw) || typeof raw.id !== "string") {
      throw new ElementInputError(
        `updateElements[${index}]: each update needs the "id" of an existing element.`,
      );
    }
    checkPayloadSize(raw, `updateElements[${index}]`);
    const current = scene.get(raw.id);
    if (!current) {
      throw new ElementInputError(
        `updateElements[${index}]: no element with id "${raw.id}" exists in this drawing.`,
      );
    }
    if (removeSet.has(raw.id)) {
      throw new ElementInputError(
        `updateElements[${index}]: element "${raw.id}" is also listed in removeElementIds.`,
      );
    }
    if (updatedSet.has(raw.id)) {
      throw new ElementInputError(
        `updateElements[${index}]: element "${raw.id}" is updated more than once in this call.`,
      );
    }
    if (raw.type !== undefined && raw.type !== current.type) {
      throw new ElementInputError(
        `${where}: the type of an element cannot be changed (it is "${current.type}"); remove it and add a new element instead.`,
      );
    }
    if (!SUPPORTED_TYPES.has(current.type)) {
      throw new ElementInputError(
        `${where}: elements of type "${current.type}" cannot be edited by this tool; they can only be removed.`,
      );
    }
    if (current.isDeleted && raw.isDeleted !== false) {
      throw new ElementInputError(
        `${where}: element "${raw.id}" is deleted. Pass "isDeleted": false to restore it.`,
      );
    }
    const label = parseLabel(raw, current.type, where);
    const fields = pickKnownKeys(raw, current.type);
    for (const key of SERVER_OWNED_ON_UPDATE) delete fields[key];
    if (current.type !== "text") delete fields.text;
    const startShorthand = parseShorthandBinding(raw, "start", where);
    const endShorthand = parseShorthandBinding(raw, "end", where);
    if (startShorthand && fields.startBinding === undefined) {
      fields.startBinding = startShorthand;
    }
    if (endShorthand && fields.endBinding === undefined) {
      fields.endBinding = endShorthand;
    }
    const next = completeElement(
      { ...fields, type: current.type },
      where,
      current,
    );
    scene.set(next.id, next);
    touched.add(next.id);
    updatedSet.add(next.id);
    updatedIds.push(next.id);
    if (GEOMETRY_KEYS.some((key) => !sameJson(current[key], next[key]))) {
      geometryChanged.add(next.id);
    }
    if (["x", "y", "points"].some((key) => fields[key] !== undefined)) {
      explicitPosition.add(next.id);
    }
    if (label !== undefined) labelUpdates.push({ container: next, label });
  });
  for (const { container, label } of labelUpdates) {
    const existingLabel = boundTextOf(container);
    if (label === null) {
      if (existingLabel) removeOne(existingLabel.id);
      continue;
    }
    if (existingLabel) {
      const props: Record<string, any> = { text: label.text };
      for (const key of LABEL_PROP_KEYS) {
        if (label.props[key] !== undefined) props[key] = label.props[key];
      }
      const next = completeElement(
        { ...props, type: "text" },
        `Label of "${container.id}"`,
        existingLabel,
      );
      scene.set(next.id, next);
      touched.add(next.id);
      labelIds[container.id] = next.id;
    } else {
      insert(makeLabel(container, label, `Element "${container.id}"`));
    }
  }

  // 3. Additions.
  const addedSet = new Set<string>();
  addInput.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new ElementInputError(`addElements[${index}] must be an object.`);
    }
    const where = describeElement(raw, index);
    checkPayloadSize(raw, where);
    const type = raw.type;
    if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
      throw new ElementInputError(
        `${where}: "type" must be one of ${SUPPORTED_ELEMENT_TYPES.join(", ")}.`,
      );
    }
    const id = elementId(raw.id, "id", where);
    if (id && (scene.has(id) || addedSet.has(id))) {
      throw new ElementInputError(
        `${where}: an element with id "${id}" already exists; use a new id (or updateElements to change it).`,
      );
    }
    const label = parseLabel(raw, type, where);
    const fields = pickKnownKeys(raw, type);
    if (type !== "text") delete fields.text;
    if (type === "arrow") {
      fields.startBinding ??= parseShorthandBinding(raw, "start", where);
      fields.endBinding ??= parseShorthandBinding(raw, "end", where);
    }
    const element = completeElement({ ...fields, type }, where);
    if (["x", "y", "points"].some((key) => fields[key] !== undefined)) {
      explicitPosition.add(element.id);
    }
    insert(element);
    addedSet.add(element.id);
    addedIds.push(element.id);
    if (label) insert(makeLabel(element, label, where));
  });

  // 4. Cross-element consistency for everything touched by this call.
  for (const id of touched) {
    const element = scene.get(id)!;
    if (element.isDeleted) continue;
    const where = `Element "${id}"`;
    if (element.frameId) {
      const frame = live(element.frameId);
      if (!frame || frame.type !== "frame" || frame.id === id) {
        throw new ElementInputError(
          `${where}: frameId "${element.frameId}" does not name a frame in this drawing.`,
        );
      }
    }
    if (element.type === "text" && element.containerId) {
      const container = live(element.containerId);
      if (!container || !CONTAINER_TYPES.has(container.type)) {
        throw new ElementInputError(
          `${where}: containerId "${element.containerId}" must name a rectangle, ellipse, diamond or arrow in this drawing.`,
        );
      }
      const other = boundTextOf(container);
      if (other && other.id !== id) {
        throw new ElementInputError(
          `${where}: element "${container.id}" already has a label ("${other.id}"); update that label instead.`,
        );
      }
    }
    for (const binding of ["startBinding", "endBinding"]) {
      const targetId = element[binding]?.elementId;
      if (!targetId) continue;
      const target = live(targetId);
      if (!target || !BINDABLE_TYPES.has(target.type) || target.id === id) {
        throw new ElementInputError(
          `${where}: ${binding} must name a shape (rectangle, ellipse, diamond, text, frame) in this drawing; "${targetId}" is not one.`,
        );
      }
    }
  }
  for (const id of touched) {
    const element = scene.get(id)!;
    const before = original.get(id);
    // Unlink references this element no longer has.
    if (before) {
      if (
        before.type === "text" &&
        before.containerId &&
        (element.isDeleted || before.containerId !== element.containerId)
      ) {
        const container = scene.get(before.containerId);
        if (container) removeBoundEntry(container, id);
      }
      for (const binding of ["startBinding", "endBinding"]) {
        const oldTarget = before[binding]?.elementId;
        if (
          oldTarget &&
          (element.isDeleted ||
            (element.startBinding?.elementId !== oldTarget &&
              element.endBinding?.elementId !== oldTarget))
        ) {
          const target = scene.get(oldTarget);
          if (target) removeBoundEntry(target, id);
        }
      }
    }
    if (element.isDeleted) continue;
    // Keep only boundElements entries that point back at this element.
    if (Array.isArray(element.boundElements)) {
      const seen = new Set<string>();
      const kept = element.boundElements.filter(
        (entry: { id: string; type: string }) => {
          const other = live(entry.id);
          if (!other || seen.has(entry.id)) return false;
          const pointsBack =
            entry.type === "text"
              ? other.type === "text" && other.containerId === id
              : other.startBinding?.elementId === id ||
                other.endBinding?.elementId === id;
          if (pointsBack) seen.add(entry.id);
          return pointsBack;
        },
      );
      element.boundElements = kept.length > 0 ? kept : null;
    }
  }
  for (const id of touched) {
    const element = scene.get(id)!;
    if (element.isDeleted) continue;
    if (element.type === "text" && element.containerId) {
      addBoundEntry(scene.get(element.containerId)!, id, "text");
    }
    for (const binding of ["startBinding", "endBinding"]) {
      const targetId = element[binding]?.elementId;
      if (targetId) addBoundEntry(scene.get(targetId)!, id, "arrow");
    }
  }

  // 5. Route straight arrows bound at both ends: new arrows and re-bound
  //    arrows without explicit coordinates, and 2-point arrows whose shapes
  //    moved.
  const rerouted = new Set<string>();
  for (const id of order) {
    const arrow = live(id);
    if (!arrow || arrow.type !== "arrow") continue;
    const start = live(arrow.startBinding?.elementId);
    const end = live(arrow.endBinding?.elementId);
    if (!start || !end || explicitPosition.has(id)) continue;
    const before = original.get(id);
    const rebound =
      !before ||
      before.startBinding?.elementId !== start.id ||
      before.endBinding?.elementId !== end.id;
    const endpointsMoved =
      geometryChanged.has(start.id) || geometryChanged.has(end.id);
    const shouldRoute =
      rebound || (endpointsMoved && arrow.points?.length === 2);
    if (shouldRoute && routeArrow(arrow, start, end)) {
      rerouted.add(id);
      touched.add(id);
    }
  }

  // 6. Size and place label text inside its container. Labels whose text
  //    and container size are unchanged only follow the container, so text
  //    Excalidraw already measured with the real font is not re-wrapped.
  for (const id of order) {
    const text = live(id);
    if (!text || text.type !== "text" || !text.containerId) continue;
    const container = live(text.containerId);
    if (!container) continue;
    const textBefore = original.get(id);
    const containerBefore = original.get(container.id);
    const textChanged =
      !textBefore ||
      textBefore.isDeleted ||
      textBefore.containerId !== text.containerId ||
      ["originalText", "fontSize", "fontFamily", "lineHeight"].some(
        (key) => !sameJson(textBefore[key], text[key]),
      );
    const resized =
      !containerBefore ||
      containerBefore.width !== container.width ||
      containerBefore.height !== container.height;
    if (textChanged || (resized && container.type !== "arrow")) {
      layoutBoundText(text, container);
    } else if (rerouted.has(container.id) || container.type === "arrow") {
      if (rerouted.has(container.id) || geometryChanged.has(container.id)) {
        const middle = midpointOf(container);
        text.x = middle.x - text.width / 2;
        text.y = middle.y - text.height / 2;
      }
    } else if (containerBefore) {
      text.x += container.x - containerBefore.x;
      text.y += container.y - containerBefore.y;
    }
  }

  // 7. Bump bookkeeping on every pre-existing element that changed.
  const elements = order.map((id) => scene.get(id)!);
  let changedCount = 0;
  for (const element of elements) {
    const before = original.get(element.id);
    if (!before) {
      element.updated = now;
      continue;
    }
    if (sameJson(before, element)) continue;
    changedCount += 1;
    const previousVersion =
      typeof before.version === "number" && Number.isFinite(before.version)
        ? before.version
        : 0;
    element.version = Math.floor(previousVersion) + 1;
    let nonce = randomInteger();
    if (nonce === before.versionNonce) nonce = randomInteger();
    element.versionNonce = nonce;
    element.updated = now;
  }

  return {
    elements,
    addedIds,
    labelIds,
    updatedIds,
    removedIds,
    changedCount,
  };
};

/** Normalise the elements of a brand-new drawing. */
export const normalizeNewElements = (
  input: unknown[],
  options: { now?: number } = {},
) => applyElementEdits([], { addElements: input }, options);

const centerOf = (element: SceneElement) => ({
  x: element.x + element.width / 2,
  y: element.y + element.height / 2,
});

/** Distance from the shape centre to its outline along a unit direction. */
const outlineDistance = (element: SceneElement, ux: number, uy: number) => {
  const a = Math.max(element.width / 2, 0.5);
  const b = Math.max(element.height / 2, 0.5);
  const ax = Math.abs(ux);
  const ay = Math.abs(uy);
  if (element.type === "ellipse") {
    return 1 / Math.sqrt((ux / a) ** 2 + (uy / b) ** 2);
  }
  if (element.type === "diamond") {
    return 1 / (ax / a + ay / b);
  }
  return Math.min(ax > 1e-9 ? a / ax : Infinity, ay > 1e-9 ? b / ay : Infinity);
};

const routeArrow = (
  arrow: SceneElement,
  start: SceneElement,
  end: SceneElement,
): boolean => {
  const from = centerOf(start);
  const to = centerOf(end);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return false;
  const ux = dx / length;
  const uy = dy / length;
  const startGap = arrow.startBinding?.gap ?? BINDING_GAP;
  const endGap = arrow.endBinding?.gap ?? BINDING_GAP;
  const startOffset = outlineDistance(start, ux, uy) + startGap;
  const endOffset = outlineDistance(end, ux, uy) + endGap;
  if (startOffset + endOffset >= length) return false;
  const sx = from.x + ux * startOffset;
  const sy = from.y + uy * startOffset;
  const ex = to.x - ux * endOffset;
  const ey = to.y - uy * endOffset;
  const round = (value: number) => Math.round(value * 100) / 100;
  arrow.x = round(sx);
  arrow.y = round(sy);
  arrow.points = [
    [0, 0],
    [round(ex - sx), round(ey - sy)],
  ];
  arrow.width = Math.abs(round(ex - sx));
  arrow.height = Math.abs(round(ey - sy));
  arrow.startBinding = { ...arrow.startBinding, focus: 0, gap: startGap };
  arrow.endBinding = { ...arrow.endBinding, focus: 0, gap: endGap };
  return true;
};

const boundTextMaxSize = (container: SceneElement) => {
  const pad = BOUND_TEXT_PADDING * 2;
  if (container.type === "ellipse") {
    return {
      width: Math.round((container.width / 2) * Math.SQRT2) - pad,
      height: Math.round((container.height / 2) * Math.SQRT2) - pad,
    };
  }
  if (container.type === "diamond") {
    return {
      width: Math.round(container.width / 2) - pad,
      height: Math.round(container.height / 2) - pad,
    };
  }
  return { width: container.width - pad, height: container.height - pad };
};

const midpointOf = (arrow: SceneElement) => {
  const points: [number, number][] = arrow.points ?? [[0, 0]];
  const middle = Math.floor((points.length - 1) / 2);
  const a = points[middle];
  const b = points[Math.min(middle + 1, points.length - 1)];
  return {
    x: arrow.x + (a[0] + b[0]) / 2,
    y: arrow.y + (a[1] + b[1]) / 2,
  };
};

const layoutBoundText = (text: SceneElement, container: SceneElement) => {
  const source =
    typeof text.originalText === "string" && text.originalText.length > 0
      ? text.originalText
      : text.text;
  if (container.type === "arrow") {
    const length = Math.hypot(container.width, container.height);
    const wrapped = wrapText(
      source,
      text.fontSize,
      Math.max(100, length * 0.7),
    );
    const size = estimateTextSize(wrapped, text.fontSize, text.lineHeight);
    const middle = midpointOf(container);
    text.text = wrapped;
    text.originalText = source;
    text.width = size.width;
    text.height = size.height;
    text.x = middle.x - size.width / 2;
    text.y = middle.y - size.height / 2;
    text.angle = 0;
    return;
  }
  let maxSize = boundTextMaxSize(container);
  const wrapped = wrapText(source, text.fontSize, Math.max(maxSize.width, 1));
  const size = estimateTextSize(wrapped, text.fontSize, text.lineHeight);
  if (size.height > maxSize.height) {
    // Grow the container so the label fits, as Excalidraw does on edit.
    const needed = size.height + BOUND_TEXT_PADDING * 2;
    const grownHeight =
      container.type === "ellipse"
        ? Math.ceil(needed * Math.SQRT2)
        : container.type === "diamond"
          ? Math.ceil(needed * 2)
          : Math.ceil(needed);
    container.height = Math.max(container.height, grownHeight);
    maxSize = boundTextMaxSize(container);
  }
  const center = centerOf(container);
  const innerLeft = center.x - maxSize.width / 2;
  const innerTop = center.y - maxSize.height / 2;
  text.text = wrapped;
  text.originalText = source;
  text.width = size.width;
  text.height = size.height;
  text.x =
    text.textAlign === "left"
      ? innerLeft
      : text.textAlign === "right"
        ? innerLeft + maxSize.width - size.width
        : center.x - size.width / 2;
  text.y =
    text.verticalAlign === "top"
      ? innerTop
      : text.verticalAlign === "bottom"
        ? innerTop + maxSize.height - size.height
        : center.y - size.height / 2;
  text.angle = container.angle ?? 0;
};
