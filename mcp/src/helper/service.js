// Node mirror of HostService.swift: identical dispatch, identical error
// mapping, identical response payloads.

import { HostFailure, REALTIME_MODEL } from "./protocol.js";
import { CredentialStoreError } from "./stores.js";
import { RealtimeClientError } from "./realtime.js";

export class HostService {
  constructor({ keyStore, importer = null, memory = null, evidence = null, realtimeClient }) {
    this.keyStore = keyStore;
    this.importer = importer;
    this.memory = memory;
    this.evidence = evidence;
    this.realtimeClient = realtimeClient;
  }

  async handle(request) {
    try {
      return { requestId: request.requestId, ok: true, data: await this.#execute(request) };
    } catch (error) {
      if (error instanceof HostFailure) return { failure: error };
      if (error instanceof CredentialStoreError) return { failure: mapCredentialError(error, request.requestId) };
      if (error instanceof RealtimeClientError) return { failure: mapRealtimeError(error, request.requestId) };
      return {
        failure: new HostFailure("INTERNAL_ERROR", "The native host could not complete the request.", false, request.requestId),
      };
    }
  }

  async #execute(request) {
    switch (request.type) {
      case "HOST_HEALTH":
        return { ready: true, configured: this.keyStore.readApiKey() !== null, model: REALTIME_MODEL };

      case "HOST_CONFIGURE_KEY":
        this.keyStore.saveApiKey(request.payload.key);
        return { configured: true };

      case "HOST_FORGET_KEY":
        this.keyStore.deleteApiKey();
        return { configured: false };

      case "HOST_IMPORT_CREDENTIALS": {
        if (!this.importer) {
          throw new HostFailure("SECURE_STORAGE_ERROR", "Credential import is unavailable in this host build.", false, request.requestId);
        }
        const outcome = this.importer.importCredentials(request.payload.provider);
        return { imported: true, provider: outcome.provider, method: outcome.method, configured: outcome.configured };
      }

      case "HOST_MEMORY_GET": {
        let notes = [];
        try {
          notes = this.memory ? this.memory.notes(request.payload.origin) : [];
        } catch {
          notes = [];
        }
        return { notes };
      }

      case "HOST_MEMORY_APPEND":
        this.memory?.append(request.payload.origin, request.payload.question, request.payload.answer);
        return { stored: true };

      case "HOST_MEMORY_CLEAR":
        this.memory?.clear(request.payload.origin);
        return { cleared: true };

      case "HOST_PUBLISH_EVIDENCE":
        this.evidence?.publish(request.payload.origin, request.payload.title, request.payload.evidence);
        return { published: true };

      case "HOST_CLEAR_EVIDENCE":
        this.evidence?.clear();
        return { cleared: true };

      case "HOST_CREATE_SESSION": {
        const apiKey = this.keyStore.readApiKey();
        if (apiKey === null) {
          throw new HostFailure("NOT_CONFIGURED", "Add an OpenAI API key in Browser Guide first.", false, request.requestId);
        }
        let result;
        try {
          result = await this.realtimeClient.createSession(request.payload.sdp, request.payload.mode, apiKey);
        } catch (error) {
          if (error instanceof RealtimeClientError && error.kind === "unauthorized") {
            // A rejected imported key may simply be stale: re-read the harness
            // source once (Codex rotates its own key) and retry.
            const refreshedKey = this.importer?.resyncOpenAiCredentialFromSource() === true
              ? this.keyStore.readApiKey()
              : null;
            if (refreshedKey === null) throw error;
            result = await this.realtimeClient.createSession(request.payload.sdp, request.payload.mode, refreshedKey);
          } else {
            throw error;
          }
        }
        const data = { answerSdp: result.answerSdp };
        if (result.upstreamRequestId) data.upstreamRequestId = result.upstreamRequestId;
        return data;
      }
    }
    throw new HostFailure("INVALID_REQUEST", "The native request payload does not match its type.", false, request.requestId);
  }
}

function mapCredentialError(error, requestId) {
  switch (error.kind) {
    case "importSourceMissing":
    case "importSourceInvalid":
      return new HostFailure("NOT_CONFIGURED", error.message, false, requestId);
    case "malformedStore":
      return new HostFailure(
        "SECURE_STORAGE_ERROR",
        "The credential store file is damaged. Remove ~/.config/browser-guide/credentials.json and add your key again.",
        false,
        requestId,
      );
    default:
      return new HostFailure("SECURE_STORAGE_ERROR", error.message, true, requestId);
  }
}

function mapRealtimeError(error, requestId) {
  switch (error.kind) {
    case "rateLimited":
      return new HostFailure("RATE_LIMITED", "OpenAI Realtime is temporarily rate limited.", true, requestId);
    case "timedOut":
      return new HostFailure("UPSTREAM_ERROR", "OpenAI Realtime did not respond before the timeout.", true, requestId);
    case "networkFailure":
      return new HostFailure("UPSTREAM_ERROR", "OpenAI Realtime could not be reached.", true, requestId);
    case "unauthorized":
      return new HostFailure("INVALID_API_KEY", "OpenAI rejected the configured API key.", false, requestId);
    case "upstreamFailure":
      return new HostFailure("UPSTREAM_ERROR", "OpenAI Realtime rejected the session request.", error.retryable, requestId);
    default:
      return new HostFailure("UPSTREAM_ERROR", "OpenAI Realtime returned an invalid session response.", false, requestId);
  }
}
