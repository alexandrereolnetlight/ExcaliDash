/**
 * Minimal incremental Server-Sent Events parser (the subset of the spec the
 * assistant endpoint uses): "event:" and "data:" fields, multi-line data,
 * comment lines (":" pings) and LF / CRLF / CR line endings, with chunks that
 * may split lines anywhere.
 */
export type SseMessage = { event: string; data: string };

export type SseParser = {
  feed: (chunk: string) => void;
  /** Flush a trailing event that was not followed by a blank line. */
  end: () => void;
};

export const createSseParser = (
  onMessage: (message: SseMessage) => void,
): SseParser => {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0) {
      onMessage({ event: eventName || "message", data: dataLines.join("\n") });
    }
    eventName = "";
    dataLines = [];
  };

  const processLine = (line: string) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  };

  return {
    feed: (chunk) => {
      buffer += chunk;
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) break;
        // A trailing CR may be the first half of a CRLF split across chunks.
        if (match[0] === "\r" && match.index === buffer.length - 1) break;
        processLine(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
    end: () => {
      if (buffer.length > 0) processLine(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    },
  };
};

/** Read a fetch response body to the end, emitting each SSE message. */
export const readSseStream = async (
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onMessage);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.end();
  } finally {
    reader.releaseLock();
  }
};
