// Chrome native-messaging framing: 4-byte little-endian length + JSON payload.
// Mirrors NativeMessageFraming.swift: 768 KiB request ceiling, 1 MiB response.

export const MAX_REQUEST_BYTES = 768 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export class FramingError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // "messageTooLarge" | "invalidFrame" | "truncated"
  }
}

export class FrameDecoder {
  #buffered = Buffer.alloc(0);

  /** Appends a chunk and returns every complete payload it finishes. */
  append(chunk) {
    this.#buffered = Buffer.concat([this.#buffered, chunk]);
    const payloads = [];
    while (this.#buffered.length >= 4) {
      const length = this.#buffered.readUInt32LE(0);
      if (length > MAX_REQUEST_BYTES) throw new FramingError("messageTooLarge");
      if (length === 0) throw new FramingError("invalidFrame");
      if (this.#buffered.length < length + 4) break;
      payloads.push(this.#buffered.subarray(4, length + 4));
      this.#buffered = this.#buffered.subarray(length + 4);
    }
    return payloads;
  }

  /** Called at EOF: leftover bytes mean the stream died mid-frame. */
  finish() {
    if (this.#buffered.length !== 0) throw new FramingError("truncated");
  }
}

export function encodeFrame(payload) {
  if (payload.length === 0 || payload.length > MAX_RESPONSE_BYTES) {
    throw new FramingError("messageTooLarge");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}
