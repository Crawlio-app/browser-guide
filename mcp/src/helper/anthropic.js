// Node mirror of AnthropicClient.swift: the Claude engine's completion relay.
// The panel owns the conversation; this injects the model, the read-only
// contract (system + tools), and the user's own imported OAuth token.

import { GUIDE_ANTHROPIC_TOOLS, READ_ONLY_INSTRUCTIONS } from "./contract.js";
import { RealtimeClientError } from "./realtime.js";

export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_MODEL = "claude-sonnet-5";
const API_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
const MAX_RESPONSE_TOKENS = 1_024;

export class AnthropicClient {
  constructor({ transport = null, timeoutSeconds = 60 } = {}) {
    this.transport = transport;
    this.timeoutSeconds = timeoutSeconds;
  }

  async complete(messages, accessToken) {
    let status;
    let body;
    if (this.transport) {
      ({ status, body } = await this.transport({ messages }));
    } else {
      let response;
      try {
        response = await fetch(ANTHROPIC_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            "anthropic-version": API_VERSION,
            "anthropic-beta": OAUTH_BETA,
          },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: MAX_RESPONSE_TOKENS,
            system: READ_ONLY_INSTRUCTIONS,
            tools: GUIDE_ANTHROPIC_TOOLS,
            messages,
          }),
          signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
        });
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new RealtimeClientError("timedOut", true);
        throw new RealtimeClientError("networkFailure", true);
      }
      status = response.status;
      try {
        body = await response.json();
      } catch {
        throw new RealtimeClientError("invalidResponse");
      }
    }

    if (status === 401 || status === 403) throw new RealtimeClientError("unauthorized");
    if (status === 429) throw new RealtimeClientError("rateLimited", true);
    if (status >= 500 && status < 600) throw new RealtimeClientError("upstreamFailure", true);
    if (status !== 200) throw new RealtimeClientError("upstreamFailure", false);

    const content = Array.isArray(body?.content) ? body.content : null;
    if (!content) throw new RealtimeClientError("invalidResponse");
    // Sanitize: only the shapes the panel's tool loop expects survive.
    const sanitized = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        sanitized.push({ type: "text", text: block.text.slice(0, 30_000) });
      } else if (block?.type === "tool_use"
        && typeof block.id === "string" && block.id.length <= 200
        && typeof block.name === "string" && block.name.length <= 64
        && typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)) {
        sanitized.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }
    if (sanitized.length === 0) throw new RealtimeClientError("invalidResponse");
    const stopReason = typeof body.stop_reason === "string" && body.stop_reason.length <= 40
      ? body.stop_reason
      : "end_turn";
    return { content: sanitized, stopReason };
  }
}
