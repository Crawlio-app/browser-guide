// Node mirror of HostProtocol.swift's HostProtocolCodec: same request types,
// same strict validation, and the same error codes, messages, and retryability
// byte for byte. The Swift conformance tests in tests/native/ run unchanged
// against this implementation; any divergence is a bug here.

import { MAX_REQUEST_BYTES } from "./framing.js";

export const HOST_NAME = "com.crawlio.browser_guide";
export const PROTOCOL_VERSION = 1;
export const REALTIME_MODEL = "gpt-realtime";
export const MAX_SDP_BYTES = 512 * 1024;
export const MAX_API_KEY_BYTES = 503;
export const MAX_EVIDENCE_TITLE = 300;
export const MAX_EVIDENCE_CHARS = 200_000;
export const UNKNOWN_REQUEST_ID = "00000000-0000-4000-8000-000000000000";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,500}$/;

export class HostFailure extends Error {
  constructor(code, message, retryable, requestId) {
    super(message);
    this.code = code;
    this.failureMessage = message.slice(0, 1000);
    this.retryable = retryable;
    this.requestId = requestId;
  }
}

const invalid = (message, requestId = UNKNOWN_REQUEST_ID) =>
  new HostFailure("INVALID_REQUEST", message, false, requestId);

export function isValidSdp(value) {
  const size = Buffer.byteLength(value, "utf8");
  return size >= 4 && size <= MAX_SDP_BYTES
    && (value.startsWith("v=0\r\n") || value.startsWith("v=0\n"));
}

export function isWebOrigin(value) {
  if (typeof value !== "string" || value.length > 500) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:")
    && url.hostname.length > 0
    && (url.pathname === "" || url.pathname === "/");
}

function exactPayload(rawPayload, keys, requestId) {
  if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) {
    throw invalid("The native request payload contains missing or unsupported fields.", requestId);
  }
  const actual = Object.keys(rawPayload);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(rawPayload, key))) {
    throw invalid("The native request payload contains missing or unsupported fields.", requestId);
  }
  return rawPayload;
}

export function decodeRequest(data) {
  if (data.length > MAX_REQUEST_BYTES) {
    throw new HostFailure("PAYLOAD_TOO_LARGE", "The native message exceeds the allowed size.", false, UNKNOWN_REQUEST_ID);
  }
  let object;
  try {
    object = JSON.parse(data.toString("utf8"));
  } catch {
    throw invalid("The native message is not valid JSON.");
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    throw invalid("The native message must be a JSON object.");
  }

  const candidateRequestId = typeof object.requestId === "string" && REQUEST_ID_PATTERN.test(object.requestId)
    ? object.requestId
    : UNKNOWN_REQUEST_ID;
  const rootKeys = Object.keys(object);
  const allowedRoot = ["version", "requestId", "type", "payload"];
  const requiredRoot = ["version", "requestId", "type"];
  if (!rootKeys.every((key) => allowedRoot.includes(key)) || !requiredRoot.every((key) => rootKeys.includes(key))) {
    throw invalid("The native request contains missing or unsupported fields.", candidateRequestId);
  }
  if (typeof object.version !== "number" || !Number.isInteger(object.version) || object.version !== PROTOCOL_VERSION) {
    throw new HostFailure("UNSUPPORTED_VERSION", "Unsupported native messaging protocol version.", false, candidateRequestId);
  }
  if (typeof object.requestId !== "string" || !REQUEST_ID_PATTERN.test(object.requestId)) {
    throw invalid("requestId must be a canonical UUID.");
  }
  const requestId = object.requestId;
  const type = object.type;
  const knownTypes = [
    "HOST_HEALTH", "HOST_CONFIGURE_KEY", "HOST_FORGET_KEY", "HOST_CREATE_SESSION",
    "HOST_IMPORT_CREDENTIALS", "HOST_MEMORY_GET", "HOST_MEMORY_APPEND", "HOST_MEMORY_CLEAR",
    "HOST_PUBLISH_EVIDENCE", "HOST_CLEAR_EVIDENCE",
  ];
  if (typeof type !== "string" || !knownTypes.includes(type)) {
    throw invalid("The native request type is unsupported.", requestId);
  }

  switch (type) {
    case "HOST_HEALTH":
    case "HOST_FORGET_KEY":
    case "HOST_CLEAR_EVIDENCE": {
      if (object.payload !== undefined) {
        throw invalid("This native request must omit payload.", requestId);
      }
      return { requestId, type, payload: null };
    }

    case "HOST_CONFIGURE_KEY": {
      const payload = exactPayload(object.payload, ["key"], requestId);
      const key = payload.key;
      if (typeof key !== "string") throw invalid("The key payload is invalid.", requestId);
      const trimmed = key.trim();
      if (trimmed !== key
        || Buffer.byteLength(trimmed, "utf8") > MAX_API_KEY_BYTES
        || !API_KEY_PATTERN.test(trimmed)) {
        throw invalid("Enter a valid OpenAI API key.", requestId);
      }
      return { requestId, type, payload: { key: trimmed } };
    }

    case "HOST_IMPORT_CREDENTIALS": {
      const payload = exactPayload(object.payload, ["provider"], requestId);
      if (payload.provider !== "codex" && payload.provider !== "claude-code") {
        throw invalid("The import payload is invalid.", requestId);
      }
      return { requestId, type, payload: { provider: payload.provider } };
    }

    case "HOST_MEMORY_GET": {
      const payload = exactPayload(object.payload, ["origin"], requestId);
      if (!isWebOrigin(payload.origin)) throw invalid("The memory payload is invalid.", requestId);
      return { requestId, type, payload: { origin: payload.origin } };
    }

    case "HOST_MEMORY_APPEND": {
      const payload = exactPayload(object.payload, ["origin", "question", "answer"], requestId);
      if (!isWebOrigin(payload.origin)
        || typeof payload.question !== "string" || payload.question.length === 0 || payload.question.length > 2000
        || typeof payload.answer !== "string" || payload.answer.length === 0 || payload.answer.length > 4000) {
        throw invalid("The memory payload is invalid.", requestId);
      }
      return { requestId, type, payload: { origin: payload.origin, question: payload.question, answer: payload.answer } };
    }

    case "HOST_MEMORY_CLEAR": {
      if (object.payload === undefined) return { requestId, type, payload: { origin: null } };
      const payload = exactPayload(object.payload, ["origin"], requestId);
      if (!isWebOrigin(payload.origin)) throw invalid("The memory payload is invalid.", requestId);
      return { requestId, type, payload: { origin: payload.origin } };
    }

    case "HOST_PUBLISH_EVIDENCE": {
      const payload = exactPayload(object.payload, ["origin", "title", "evidence"], requestId);
      if (!isWebOrigin(payload.origin)
        || typeof payload.title !== "string" || payload.title.length > MAX_EVIDENCE_TITLE
        || typeof payload.evidence !== "string" || payload.evidence.length === 0
        || payload.evidence.length > MAX_EVIDENCE_CHARS) {
        throw invalid("The evidence payload is invalid.", requestId);
      }
      return { requestId, type, payload: { origin: payload.origin, title: payload.title, evidence: payload.evidence } };
    }

    case "HOST_CREATE_SESSION": {
      const payload = exactPayload(object.payload, ["sdp", "mode"], requestId);
      if (typeof payload.sdp !== "string" || (payload.mode !== "text" && payload.mode !== "voice")) {
        throw invalid("The session payload is invalid.", requestId);
      }
      if (!isValidSdp(payload.sdp)) {
        const tooLarge = Buffer.byteLength(payload.sdp, "utf8") > MAX_SDP_BYTES;
        throw new HostFailure(
          tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
          tooLarge
            ? "The WebRTC session description exceeds the allowed size."
            : "The WebRTC session description is invalid.",
          false,
          requestId,
        );
      }
      return { requestId, type, payload: { sdp: payload.sdp, mode: payload.mode } };
    }
  }
  throw invalid("The native request type is unsupported.", requestId);
}

export function encodeSuccess(requestId, data) {
  return Buffer.from(JSON.stringify({ version: PROTOCOL_VERSION, requestId, ok: true, data }), "utf8");
}

export function encodeFailure(failure) {
  return Buffer.from(JSON.stringify({
    version: PROTOCOL_VERSION,
    requestId: failure.requestId,
    ok: false,
    error: { code: failure.code, message: failure.failureMessage, retryable: failure.retryable },
  }), "utf8");
}
