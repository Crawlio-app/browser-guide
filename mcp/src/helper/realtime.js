// Node mirror of RealtimeClient.swift: identical multipart body, session
// configuration, status mapping, and response validation.

import { randomUUID } from "node:crypto";
import { MAX_REQUEST_BYTES } from "./framing.js";
import { MAX_SDP_BYTES, REALTIME_MODEL, isValidSdp } from "./protocol.js";
import { GUIDE_REALTIME_TOOLS, READ_ONLY_INSTRUCTIONS } from "./contract.js";

export const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/calls";

export class RealtimeClientError extends Error {
  constructor(kind, retryable = false) {
    super(kind);
    this.kind = kind; // "timedOut" | "networkFailure" | "unauthorized" | "rateLimited" | "upstreamFailure" | "invalidResponse"
    this.retryable = retryable;
  }
}

function sessionConfiguration(mode) {
  const session = {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions: READ_ONLY_INSTRUCTIONS,
    output_modalities: mode === "voice" ? ["audio"] : ["text"],
    tools: GUIDE_REALTIME_TOOLS,
    tool_choice: "auto",
  };
  if (mode === "voice") {
    session.audio = {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },
        // The user's press ends the turn, never the server.
        turn_detection: { type: "semantic_vad", eagerness: "low", create_response: false, interrupt_response: false },
      },
      output: { voice: "marin" },
    };
  }
  return session;
}

function multipartBody(boundary, sdp, sessionJson) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sdp"\r\nContent-Type: application/sdp\r\n\r\n${sdp}\r\n--${boundary}\r\nContent-Disposition: form-data; name="session"\r\nContent-Type: application/json\r\n\r\n`, "utf8"),
    Buffer.from(sessionJson, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
}

function sanitizedRequestId(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128) return null;
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

export class RealtimeClient {
  constructor({ transport = null, timeoutSeconds = 20 } = {}) {
    this.transport = transport;
    this.timeoutSeconds = timeoutSeconds;
  }

  async createSession(sdp, mode, apiKey) {
    if (!isValidSdp(sdp)) throw new RealtimeClientError("invalidResponse");
    const boundary = "BrowserGuide-" + randomUUID();
    const body = multipartBody(boundary, sdp, JSON.stringify(sessionConfiguration(mode)));
    if (body.length > MAX_REQUEST_BYTES) throw new RealtimeClientError("invalidResponse");

    let status;
    let responseBody;
    let requestIdHeader;
    if (this.transport) {
      ({ status, body: responseBody, requestIdHeader } = await this.transport({ mode }));
    } else {
      let response;
      try {
        response = await fetch(REALTIME_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Cache-Control": "no-store",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
        });
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new RealtimeClientError("timedOut", true);
        throw new RealtimeClientError("networkFailure", true);
      }
      status = response.status;
      requestIdHeader = response.headers.get("x-request-id");
      try {
        responseBody = await response.text();
      } catch {
        throw new RealtimeClientError("invalidResponse");
      }
    }

    if (status >= 200 && status < 300) {
      // fall through to body validation
    } else if (status === 401 || status === 403) {
      throw new RealtimeClientError("unauthorized");
    } else if (status === 429) {
      throw new RealtimeClientError("rateLimited", true);
    } else if (status >= 500 && status < 600) {
      throw new RealtimeClientError("upstreamFailure", true);
    } else {
      throw new RealtimeClientError("upstreamFailure", false);
    }

    if (Buffer.byteLength(responseBody, "utf8") > MAX_SDP_BYTES || !isValidSdp(responseBody)) {
      throw new RealtimeClientError("invalidResponse");
    }
    return { answerSdp: responseBody, upstreamRequestId: sanitizedRequestId(requestIdHeader) };
  }
}
