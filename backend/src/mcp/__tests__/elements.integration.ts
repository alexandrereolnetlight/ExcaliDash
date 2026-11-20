import { describe, expect, it } from "vitest";
import {
  applyElementEdits,
  DEFAULT_FONT_FAMILY,
  ElementInputError,
  estimateTextSize,
  MAX_ELEMENTS_PER_CALL,
  normalizeNewElements,
  wrapText,
  type SceneElement,
} from "../elements";
import { sanitizeDrawingData } from "../../security";

const byId = (elements: SceneElement[]) =>
  new Map(elements.map((element) => [element.id, element]));

const BASE_FIELDS = [
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
];

describe("MCP element normalisation", () => {
  it("fills every bookkeeping field Excalidraw expects", () => {
    const now = 1_700_000_000_000;
    const { elements, addedIds } = normalizeNewElements(
      [{ type: "rectangle", x: 10, y: 20, width: 200, height: 100 }],
      { now },
    );
    expect(elements).toHaveLength(1);
    const [rect] = elements;
    for (const field of BASE_FIELDS) expect(rect).toHaveProperty(field);
    expect(addedIds).toEqual([rect.id]);
    expect(rect).toMatchObject({
      type: "rectangle",
      x: 10,
      y: 20,
      width: 200,
      height: 100,
      angle: 0,
      version: 1,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      link: null,
      locked: false,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      roundness: { type: 3 },
      updated: now,
    });
    expect(rect.id).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    expect(Number.isInteger(rect.seed)).toBe(true);
    expect(Number.isInteger(rect.versionNonce)).toBe(true);
  });

  it("fills text defaults and estimates the text size", () => {
    const { elements } = normalizeNewElements([
      { type: "text", x: 0, y: 0, text: "Hello\nWorld!!" },
    ]);
    const [text] = elements;
    expect(text).toMatchObject({
      fontSize: 20,
      fontFamily: DEFAULT_FONT_FAMILY,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      originalText: "Hello\nWorld!!",
      lineHeight: 1.25,
      autoResize: true,
      roundness: null,
    });
    // 7 chars * 20 * 0.6 = 84; 2 lines * 20 * 1.25 = 50
    expect(text.width).toBe(84);
    expect(text.height).toBe(50);
    expect(estimateTextSize("abc", 10, 1.25)).toEqual({
      width: 18,
      height: 13,
    });
  });

  it("creates a bound, centred label from the label shorthand", () => {
    const { elements, labelIds } = normalizeNewElements([
      {
        id: "box",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        label: "API",
      },
    ]);
    const map = byId(elements);
    const label = map.get(labelIds.box)!;
    expect(label).toMatchObject({
      type: "text",
      text: "API",
      containerId: "box",
      textAlign: "center",
      verticalAlign: "middle",
    });
    expect(map.get("box")!.boundElements).toEqual([
      { id: label.id, type: "text" },
    ]);
    expect(label.x + label.width / 2).toBeCloseTo(100);
    expect(label.y + label.height / 2).toBeCloseTo(50);
  });

  it("treats text on a shape as its label and wraps long labels", () => {
    const { elements, labelIds } = normalizeNewElements([
      {
        id: "box",
        type: "rectangle",
        width: 120,
        height: 40,
        text: "A rather long label that needs wrapping",
      },
    ]);
    const map = byId(elements);
    const label = map.get(labelIds.box)!;
    expect(label.originalText).toBe("A rather long label that needs wrapping");
    expect(label.text).toContain("\n");
    // The container grows to fit the wrapped label.
    expect(map.get("box")!.height).toBeGreaterThanOrEqual(label.height + 10);
    expect(wrapText("aaa bbb ccc", 10, 42)).toBe("aaa bbb\nccc");
  });

  it("links explicit containerId labels back to their container", () => {
    const { elements } = normalizeNewElements([
      { id: "e", type: "ellipse", width: 160, height: 80 },
      { id: "t", type: "text", text: "Hi", containerId: "e" },
    ]);
    const map = byId(elements);
    expect(map.get("e")!.boundElements).toEqual([{ id: "t", type: "text" }]);
    expect(map.get("t")!.textAlign).toBe("center");
  });

  it("binds and routes arrows between shapes", () => {
    const { elements } = normalizeNewElements([
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", type: "rectangle", x: 300, y: 0, width: 100, height: 100 },
      {
        id: "arrow",
        type: "arrow",
        startBinding: { elementId: "a" },
        end: { id: "b" },
        label: "calls",
      },
    ]);
    const map = byId(elements);
    const arrow = map.get("arrow")!;
    expect(arrow.startBinding).toEqual({ elementId: "a", focus: 0, gap: 5 });
    expect(arrow.endBinding).toEqual({ elementId: "b", focus: 0, gap: 5 });
    expect(arrow.x).toBeCloseTo(105);
    expect(arrow.y).toBeCloseTo(50);
    expect(arrow.points).toEqual([
      [0, 0],
      [190, 0],
    ]);
    expect(arrow).toMatchObject({
      elbowed: false,
      startArrowhead: null,
      endArrowhead: "arrow",
      lastCommittedPoint: null,
      roundness: { type: 2 },
    });
    expect(map.get("a")!.boundElements).toEqual([
      { id: "arrow", type: "arrow" },
    ]);
    expect(map.get("b")!.boundElements).toEqual([
      { id: "arrow", type: "arrow" },
    ]);
    expect(arrow.boundElements).toHaveLength(1);
  });

  it("moves line origins to the first point and derives the size", () => {
    const { elements } = normalizeNewElements([
      {
        type: "line",
        x: 10,
        y: 10,
        points: [
          [5, 5],
          [55, 25],
          [5, 45],
        ],
      },
    ]);
    expect(elements[0]).toMatchObject({
      x: 15,
      y: 15,
      width: 50,
      height: 40,
      points: [
        [0, 0],
        [50, 20],
        [0, 40],
      ],
      startBinding: null,
      endBinding: null,
      endArrowhead: null,
    });
  });

  it("drops unknown fields and produces scenes the save sanitiser accepts", () => {
    const { elements } = normalizeNewElements([
      { type: "frame", name: "Frame", x: 0, y: 0, id: "f" },
      {
        type: "diamond",
        frameId: "f",
        link: "https://example.com",
        bogus: "x".repeat(1000),
      },
      {
        type: "freedraw",
        points: [
          [0, 0],
          [10, 10],
          [20, 5],
        ],
      },
      { type: "text", text: "3 < 4 & <b>ok</b>", fontFamily: "Helvetica" },
    ]);
    expect(elements[1]).not.toHaveProperty("bogus");
    expect(elements[3]).toMatchObject({ fontFamily: 2, lineHeight: 1.15 });
    const sanitized = sanitizeDrawingData({
      elements,
      appState: {},
      files: {},
    });
    expect(sanitized.elements).toEqual(elements);
  });

  it("rejects invalid input with readable errors", () => {
    const cases: [unknown[], RegExp][] = [
      [[{ type: "image" }], /"type" must be one of/],
      [[{ type: "rectangle", x: Number.NaN }], /"x" must be a finite number/],
      [[{ type: "rectangle", x: "10" }], /"x" must be a finite number/],
      [[{ type: "text" }], /need a "text"/],
      [[{ type: "rectangle", fillStyle: "plaid" }], /fillStyle/],
      [[{ type: "arrow", startBinding: { elementId: "nope" } }], /nope/],
      [[{ type: "text", text: "x", containerId: "nope" }], /containerId/],
      [[{ type: "ellipse", frameId: "nope" }], /frameId/],
      [
        [
          { type: "rectangle", id: "dup" },
          { type: "ellipse", id: "dup" },
        ],
        /already exists/,
      ],
      [[{ type: "line", points: [[0, 0]] }], /between 2 and/],
      [
        [{ type: "rectangle", customData: { blob: "x".repeat(20000) } }],
        /customData/,
      ],
      [
        [{ type: "freedraw", points: [[0, 0]], extra: "x".repeat(300000) }],
        /larger than/,
      ],
    ];
    for (const [input, message] of cases) {
      expect(() => normalizeNewElements(input), String(message)).toThrow(
        message,
      );
    }
    expect(() =>
      normalizeNewElements(
        Array.from({ length: MAX_ELEMENTS_PER_CALL + 1 }, () => ({
          type: "rectangle",
        })),
      ),
    ).toThrow(ElementInputError);
  });
});

describe("MCP element edits", () => {
  const baseScene = () =>
    normalizeNewElements(
      [
        {
          id: "a",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          label: "A",
        },
        { id: "b", type: "ellipse", x: 300, y: 0, width: 100, height: 100 },
        {
          id: "arrow",
          type: "arrow",
          startBinding: { elementId: "a" },
          endBinding: { elementId: "b" },
        },
        { id: "note", type: "text", x: 0, y: 300, text: "note" },
      ],
      { now: 1 },
    ).elements;

  it("updates, adds and removes while keeping links consistent", () => {
    const scene = baseScene();
    const before = byId(scene);
    const labelId = before.get("a")!.boundElements[0].id;
    const result = applyElementEdits(
      scene,
      {
        updateElements: [
          { id: "a", x: 0, y: 200, label: "Moved", backgroundColor: "#a5d8ff" },
          { id: "note", text: "longer note text" },
        ],
        addElements: [{ id: "c", type: "diamond", x: 600, y: 0 }],
        removeElementIds: ["b"],
      },
      { now: 2 },
    );
    const after = byId(result.elements);
    expect(result.addedIds).toEqual(["c"]);
    expect(result.updatedIds).toEqual(["a", "note"]);
    expect(result.removedIds).toEqual(["b"]);

    // Removal keeps a tombstone and unbinds the arrow.
    expect(after.get("b")!.isDeleted).toBe(true);
    expect(after.get("b")!.version).toBe(2);
    expect(after.get("arrow")!.endBinding).toBeNull();

    // The label follows the update and stays bound.
    const label = after.get(labelId)!;
    expect(label).toMatchObject({ text: "Moved", originalText: "Moved" });
    expect(label.y + label.height / 2).toBeCloseTo(250);
    expect(after.get("a")).toMatchObject({
      y: 200,
      backgroundColor: "#a5d8ff",
      version: 2,
      updated: 2,
    });
    expect(after.get("a")!.versionNonce).not.toBe(
      before.get("a")!.versionNonce,
    );

    // Text size is re-estimated when the text changes.
    expect(after.get("note")!.width).toBeGreaterThan(before.get("note")!.width);
    expect(after.get("note")!.originalText).toBe("longer note text");

    // Untouched elements keep their bookkeeping.
    expect(after.get("c")!.version).toBe(1);
    expect(
      sanitizeDrawingData({ elements: result.elements, appState: {} }),
    ).toBeTruthy();
  });

  it("re-routes bound arrows when a shape moves", () => {
    const scene = baseScene();
    const result = applyElementEdits(scene, {
      updateElements: [{ id: "b", x: 300, y: 300 }],
    });
    const arrow = byId(result.elements).get("arrow")!;
    expect(arrow.version).toBe(2);
    const end = arrow.points[1];
    expect(end[0]).toBeGreaterThan(0);
    expect(end[1]).toBeGreaterThan(0);
  });

  it("removes labels with their container and cleans up deleted labels", () => {
    const scene = baseScene();
    const labelId = byId(scene).get("a")!.boundElements[0].id;
    const removed = byId(
      applyElementEdits(scene, { removeElementIds: ["a"] }).elements,
    );
    expect(removed.get(labelId)!.isDeleted).toBe(true);
    expect(removed.get("arrow")!.startBinding).toBeNull();

    const unlabelled = byId(
      applyElementEdits(scene, { updateElements: [{ id: "a", label: null }] })
        .elements,
    );
    expect(unlabelled.get(labelId)!.isDeleted).toBe(true);
    expect(unlabelled.get("a")!.boundElements).toEqual([
      { id: "arrow", type: "arrow" },
    ]);
  });

  it("does not mutate the input scene and rejects bad edits", () => {
    const scene = baseScene();
    const snapshot = JSON.stringify(scene);
    applyElementEdits(scene, { updateElements: [{ id: "a", x: 50 }] });
    expect(JSON.stringify(scene)).toBe(snapshot);

    expect(() =>
      applyElementEdits(scene, { updateElements: [{ id: "missing", x: 1 }] }),
    ).toThrow(/no element with id "missing"/);
    expect(() =>
      applyElementEdits(scene, {
        updateElements: [{ id: "a", type: "ellipse" }],
      }),
    ).toThrow(/cannot be changed/);
    expect(() =>
      applyElementEdits(scene, { removeElementIds: ["missing"] }),
    ).toThrow(/missing/);
    expect(() =>
      applyElementEdits(scene, { addElements: [{ id: "a", type: "ellipse" }] }),
    ).toThrow(/already exists/);
    expect(() =>
      applyElementEdits(
        [{ id: "img", type: "image", x: 0, y: 0, version: 1 }],
        { updateElements: [{ id: "img", x: 5 }] },
      ),
    ).toThrow(/cannot be edited/);
  });

  it("keeps legacy field values it would not accept as input", () => {
    const legacy = {
      id: "old",
      type: "text",
      x: 0,
      y: 0,
      width: 50,
      height: 25,
      text: "legacy",
      fontFamily: 4,
      version: 7,
      versionNonce: 1,
    };
    const result = applyElementEdits([legacy], {
      updateElements: [{ id: "old", strokeColor: "#e03131" }],
    });
    expect(result.elements[0]).toMatchObject({
      fontFamily: 4,
      strokeColor: "#e03131",
      version: 8,
      width: 50,
    });
  });
});
