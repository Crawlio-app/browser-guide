import { isRecord } from "./protocol.js";

export const NATIVE_HOST_NAME = "com.crawlio.browser_guide";
export const NATIVE_PROTOCOL_VERSION = 1 as const;

// The helper accepts at most 768 KiB from Chrome; Chrome's host-to-extension
// ceiling is 1 MiB. Both checks include the serialized JSON envelope.
export const NATIVE_MAX_REQUEST_BYTES = 768 * 1_024;
export const NATIVE_MAX_RESPONSE_BYTES = 1_024 * 1_024;
export const NATIVE_MAX_API_KEY_BYTES = 503;
export const NATIVE_MAX_SDP_BYTES = 512 * 1_024;
export const NATIVE_MAX_MODEL_BYTES = 120;
export const NATIVE_MAX_ERROR_BYTES = 1_000;

export const NATIVE_MAX_MEMORY_QUESTION_CHARS = 2_000;
export const NATIVE_MAX_MEMORY_ANSWER_CHARS = 4_000;
export const NATIVE_MAX_ORIGIN_CHARS = 500;
export const NATIVE_MAX_EVIDENCE_TITLE_CHARS = 300;
export const NATIVE_MAX_EVIDENCE_CHARS = 200_000;
// Sized against the 768 KiB framed-envelope ceiling AFTER base64 inflation:
// ~557 KiB of raw 16 kHz mono 16-bit WAV, roughly 17 seconds of speech.
export const NATIVE_MAX_TRANSCRIBE_AUDIO_B64_CHARS = 760_000;
export const NATIVE_MAX_COMPLETION_MESSAGES = 24;
export const NATIVE_MAX_COMPLETION_BLOCKS = 8;
export const NATIVE_MAX_COMPLETION_TEXT_CHARS = 30_000;
export const NATIVE_MAX_TOOL_RESULT_CHARS = 4_000;

export const NATIVE_TIMEOUT_MS = {
  connect: 3_000,
  health: 3_000,
  configure: 8_000,
  forget: 8_000,
  importCredentials: 8_000,
  memory: 5_000,
  evidence: 5_000,
  transcribe: 20_000,
  complete: 60_000,
  createSession: 30_000,
} as const;

export type NativeRequestType =
  | "HOST_HEALTH"
  | "HOST_CONFIGURE_KEY"
  | "HOST_FORGET_KEY"
  | "HOST_CREATE_SESSION"
  | "HOST_IMPORT_CREDENTIALS"
  | "HOST_MEMORY_GET"
  | "HOST_MEMORY_APPEND"
  | "HOST_MEMORY_CLEAR"
  | "HOST_PUBLISH_EVIDENCE"
  | "HOST_CLEAR_EVIDENCE"
  | "HOST_TRANSCRIBE"
  | "HOST_COMPLETE";
export type CredentialProvider = "codex" | "claude-code";
export type RealtimeSessionMode = "text" | "voice";

export type NativeHostRequest =
  | { version: 1; requestId: string; type: "HOST_HEALTH" }
  | { version: 1; requestId: string; type: "HOST_CONFIGURE_KEY"; payload: { key: string } }
  | { version: 1; requestId: string; type: "HOST_FORGET_KEY" }
  | { version: 1; requestId: string; type: "HOST_CREATE_SESSION"; payload: { sdp: string; mode: RealtimeSessionMode } }
  | { version: 1; requestId: string; type: "HOST_IMPORT_CREDENTIALS"; payload: { provider: CredentialProvider } }
  | { version: 1; requestId: string; type: "HOST_MEMORY_GET"; payload: { origin: string } }
  | { version: 1; requestId: string; type: "HOST_MEMORY_APPEND"; payload: { origin: string; question: string; answer: string } }
  | { version: 1; requestId: string; type: "HOST_MEMORY_CLEAR"; payload?: { origin: string } }
  | { version: 1; requestId: string; type: "HOST_PUBLISH_EVIDENCE"; payload: { origin: string; title: string; evidence: string } }
  | { version: 1; requestId: string; type: "HOST_CLEAR_EVIDENCE" }
  | { version: 1; requestId: string; type: "HOST_TRANSCRIBE"; payload: { audio: string; format: "wav" } }
  | { version: 1; requestId: string; type: "HOST_COMPLETE"; payload: { messages: CompletionMessage[] } };

export interface CompletionTextBlock {
  type: "text";
  text: string;
}

export interface CompletionToolUseBlock {
  type: "tool_use";
  id: string;
  name: "show_guidance" | "clear_guidance";
  input: Record<string, unknown>;
}

export interface CompletionToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type CompletionRequestBlock = CompletionTextBlock | CompletionToolUseBlock | CompletionToolResultBlock;
export type CompletionResponseBlock = CompletionTextBlock | CompletionToolUseBlock;

export interface CompletionMessage {
  role: "user" | "assistant";
  content: CompletionRequestBlock[];
}

export interface NativeHealthData {
  ready: true;
  configured: boolean;
  /** Whether an imported Claude sign-in exists, enabling the Claude engine. */
  claude: boolean;
  model?: string;
}

export interface NativeConfigureData {
  configured: true;
}

export interface NativeForgetData {
  configured: false;
}

export interface NativeCreateSessionData {
  answerSdp: string;
  upstreamRequestId?: string;
}

export interface NativeImportData {
  imported: true;
  provider: CredentialProvider;
  method: "api_key" | "oauth";
  configured: boolean;
}

export interface SiteMemoryNote {
  q: string;
  a: string;
  at: number;
}

export interface NativeMemoryGetData {
  notes: SiteMemoryNote[];
}

export interface NativeMemoryAppendData {
  stored: true;
}

export interface NativeMemoryClearData {
  cleared: true;
}

export interface NativePublishEvidenceData {
  published: true;
}

export interface NativeClearEvidenceData {
  cleared: true;
}

export interface NativeTranscribeData {
  transcript: string;
}

export interface NativeCompleteData {
  content: CompletionResponseBlock[];
  stopReason: string;
}

export type NativeSuccessData =
  | NativeHealthData
  | NativeConfigureData
  | NativeForgetData
  | NativeCreateSessionData
  | NativeImportData
  | NativeMemoryGetData
  | NativeMemoryAppendData
  | NativeMemoryClearData
  | NativePublishEvidenceData
  | NativeClearEvidenceData
  | NativeTranscribeData
  | NativeCompleteData;

export const NATIVE_HOST_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "PAYLOAD_TOO_LARGE",
  "NOT_CONFIGURED",
  "INVALID_API_KEY",
  "RATE_LIMITED",
  "SECURE_STORAGE_ERROR",
  "UPSTREAM_ERROR",
  "INTERNAL_ERROR",
] as const;

export type NativeHostErrorCode = (typeof NATIVE_HOST_ERROR_CODES)[number];

export interface NativeHostError {
  code: NativeHostErrorCode;
  message: string;
  retryable: boolean;
}

export type NativeHostResponse =
  | { version: 1; requestId: string; ok: true; data: NativeSuccessData }
  | { version: 1; requestId: string; ok: false; error: NativeHostError };

export type HostBridgeRequest =
  | { type: "GUIDE_HOST_HEALTH" }
  | { type: "GUIDE_HOST_CONFIGURE_KEY"; key: string }
  | { type: "GUIDE_HOST_FORGET_KEY" }
  | { type: "GUIDE_HOST_CREATE_SESSION"; sdp: string; mode: RealtimeSessionMode }
  | { type: "GUIDE_HOST_IMPORT_CREDENTIALS"; provider: CredentialProvider }
  | { type: "GUIDE_HOST_MEMORY_GET"; origin: string }
  | { type: "GUIDE_HOST_MEMORY_APPEND"; origin: string; question: string; answer: string }
  | { type: "GUIDE_HOST_MEMORY_CLEAR"; origin?: string }
  | { type: "GUIDE_HOST_PUBLISH_EVIDENCE"; origin: string; title: string; evidence: string }
  | { type: "GUIDE_HOST_CLEAR_EVIDENCE" }
  | { type: "GUIDE_HOST_TRANSCRIBE"; audio: string; format: "wav" }
  | { type: "GUIDE_HOST_COMPLETE"; messages: CompletionMessage[] }
  | { type: "GUIDE_HOST_DISCONNECT" };

export type HostClientErrorCode = NativeHostErrorCode
  | "PERMISSION_REQUIRED"
  | "HOST_NOT_FOUND"
  | "HOST_DISCONNECTED"
  | "TIMEOUT"
  | "INVALID_RESPONSE";

export interface HostClientFailure {
  ok: false;
  error: string;
  code: HostClientErrorCode;
  retryable: boolean;
  permissionNeeded?: true;
}

export interface HostHealthResponse {
  ok: true;
  health: NativeHealthData;
}

export interface HostConfigureResponse {
  ok: true;
  configured: true;
}

export interface HostForgetResponse {
  ok: true;
  configured: false;
}

export interface HostCreateSessionResponse {
  ok: true;
  answerSdp: string;
  upstreamRequestId?: string;
}

export interface HostImportResponse {
  ok: true;
  imported: true;
  provider: CredentialProvider;
  method: "api_key" | "oauth";
  configured: boolean;
}

export interface HostMemoryGetResponse {
  ok: true;
  notes: SiteMemoryNote[];
}

export interface HostMemoryAppendResponse {
  ok: true;
  stored: true;
}

export interface HostMemoryClearResponse {
  ok: true;
  cleared: true;
}

export interface HostPublishEvidenceResponse {
  ok: true;
  published: true;
}

export interface HostClearEvidenceResponse {
  ok: true;
  cleared: true;
}

export interface HostTranscribeResponse {
  ok: true;
  transcript: string;
}

export interface HostCompleteResponse {
  ok: true;
  content: CompletionResponseBlock[];
  stopReason: string;
}

export interface HostDisconnectResponse {
  ok: true;
}

export type HostClientResponse = HostClientFailure
  | HostHealthResponse
  | HostConfigureResponse
  | HostForgetResponse
  | HostCreateSessionResponse
  | HostImportResponse
  | HostMemoryGetResponse
  | HostMemoryAppendResponse
  | HostMemoryClearResponse
  | HostPublishEvidenceResponse
  | HostClearEvidenceResponse
  | HostTranscribeResponse
  | HostCompleteResponse
  | HostDisconnectResponse;

export function isHostBridgeRequest(value: unknown): value is HostBridgeRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "GUIDE_HOST_HEALTH":
    case "GUIDE_HOST_FORGET_KEY":
    case "GUIDE_HOST_DISCONNECT":
      return hasExactKeys(value, ["type"]);
    case "GUIDE_HOST_CONFIGURE_KEY":
      return hasExactKeys(value, ["type", "key"]) && isApiKey(value.key);
    case "GUIDE_HOST_CREATE_SESSION":
      return hasExactKeys(value, ["type", "sdp", "mode"])
        && isSessionMode(value.mode)
        && isSdp(value.sdp);
    case "GUIDE_HOST_IMPORT_CREDENTIALS":
      return hasExactKeys(value, ["type", "provider"]) && isCredentialProvider(value.provider);
    case "GUIDE_HOST_MEMORY_GET":
      return hasExactKeys(value, ["type", "origin"]) && isWebOrigin(value.origin);
    case "GUIDE_HOST_MEMORY_APPEND":
      return hasExactKeys(value, ["type", "origin", "question", "answer"])
        && isWebOrigin(value.origin)
        && isMemoryText(value.question, NATIVE_MAX_MEMORY_QUESTION_CHARS)
        && isMemoryText(value.answer, NATIVE_MAX_MEMORY_ANSWER_CHARS);
    case "GUIDE_HOST_MEMORY_CLEAR":
      return hasExactKeys(value, ["type"], ["origin"])
        && (value.origin === undefined || isWebOrigin(value.origin));
    case "GUIDE_HOST_PUBLISH_EVIDENCE":
      return hasExactKeys(value, ["type", "origin", "title", "evidence"])
        && isWebOrigin(value.origin)
        && isEvidenceTitle(value.title)
        && isEvidenceText(value.evidence);
    case "GUIDE_HOST_CLEAR_EVIDENCE":
      return hasExactKeys(value, ["type"]);
    case "GUIDE_HOST_TRANSCRIBE":
      return hasExactKeys(value, ["type", "audio", "format"])
        && value.format === "wav"
        && isTranscribeAudio(value.audio);
    case "GUIDE_HOST_COMPLETE":
      return hasExactKeys(value, ["type", "messages"])
        && isCompletionMessages(value.messages);
    default:
      return false;
  }
}

export function isNativeHostRequest(value: unknown): value is NativeHostRequest {
  if (!isRecord(value)
    || value.version !== NATIVE_PROTOCOL_VERSION
    || !isRequestId(value.requestId)
    || typeof value.type !== "string"
    || !fitsJsonSize(value, NATIVE_MAX_REQUEST_BYTES)) return false;
  switch (value.type) {
    case "HOST_HEALTH":
    case "HOST_FORGET_KEY":
      return hasExactKeys(value, ["version", "requestId", "type"]);
    case "HOST_CONFIGURE_KEY":
      return hasExactKeys(value, ["version", "requestId", "type", "payload"])
        && isRecord(value.payload)
        && hasExactKeys(value.payload, ["key"])
        && isApiKey(value.payload.key);
    case "HOST_CREATE_SESSION":
      return hasExactKeys(value, ["version", "requestId", "type", "payload"])
        && isRecord(value.payload)
        && hasExactKeys(value.payload, ["sdp", "mode"])
        && isSessionMode(value.payload.mode)
        && isSdp(value.payload.sdp);
    case "HOST_IMPORT_CREDENTIALS":
      return hasExactKeys(value, ["version", "requestId", "type", "payload"])
        && isRecord(value.payload)
        && hasExactKeys(value.payload, ["provider"])
        && isCredentialProvider(value.payload.provider);
    case "HOST_MEMORY_GET":
      return hasExactKeys(value, ["version", "requestId", "type", "payload"])
        && isRecord(value.payload)
        && hasExactKeys(value.payload, ["origin"])
        && isWebOrigin(value.payload.origin);
    case "HOST_MEMORY_APPEND":
      return hasExactKeys(value, ["version", "requestId", "type", "payload"])
        && isRecord(value.payload)
        && hasExactKeys(value.payload, ["origin", "question", "answer"])
        && isWebOrigin(value.payload.origin)
        && isMemoryText(value.payload.question, NATIVE_MAX_MEMORY_QUESTION_CHARS)
        && isMemoryText(value.payload.answer, NATIVE_MAX_MEMORY_ANSWER_CHARS);
    case "HOST_MEMORY_CLEAR":
      if (hasExactKeys(value, ["version", "requestId", "type"])) return true;
      return hasExactKeys(value, ["version", "requestId", "type", "payload"])
        && isRecord(value.payload)
        && hasExactKeys(value.payload, ["origin"])
        && isWebOrigin(value.payload.origin);
    case "HOST_PUBLISH_EVIDENCE":
      return hasExactKeys(value, ["version", "requestId", "type", "payload"])
        && isRecord(value.payload)
        && hasExactKeys(value.payload, ["origin", "title", "evidence"])
        && isWebOrigin(value.payload.origin)
        && isEvidenceTitle(value.payload.title)
        && isEvidenceText(value.payload.evidence);
    case "HOST_CLEAR_EVIDENCE":
      return hasExactKeys(value, ["version", "requestId", "type"]);
    case "HOST_TRANSCRIBE":
      return hasExactKeys(value, ["version", "requestId", "type", "payload"])
        && isRecord(value.payload)
        && hasExactKeys(value.payload, ["audio", "format"])
        && value.payload.format === "wav"
        && isTranscribeAudio(value.payload.audio);
    case "HOST_COMPLETE":
      return hasExactKeys(value, ["version", "requestId", "type", "payload"])
        && isRecord(value.payload)
        && hasExactKeys(value.payload, ["messages"])
        && isCompletionMessages(value.payload.messages);
    default:
      return false;
  }
}

export function isNativeHostResponseFor(
  value: unknown,
  requestType: NativeRequestType,
  requestId?: string,
): value is NativeHostResponse {
  if (!isRecord(value)
    || value.version !== NATIVE_PROTOCOL_VERSION
    || !isRequestId(value.requestId)
    || (requestId !== undefined && value.requestId !== requestId)
    || typeof value.ok !== "boolean"
    || !fitsJsonSize(value, NATIVE_MAX_RESPONSE_BYTES)) return false;
  if (!value.ok) {
    return hasExactKeys(value, ["version", "requestId", "ok", "error"])
      && isNativeHostError(value.error);
  }
  if (!hasExactKeys(value, ["version", "requestId", "ok", "data"])) return false;
  switch (requestType) {
    case "HOST_HEALTH":
      return isNativeHealthData(value.data);
    case "HOST_CONFIGURE_KEY":
      return isNativeConfigureData(value.data);
    case "HOST_FORGET_KEY":
      return isNativeForgetData(value.data);
    case "HOST_CREATE_SESSION":
      return isNativeCreateSessionData(value.data);
    case "HOST_IMPORT_CREDENTIALS":
      return isNativeImportData(value.data);
    case "HOST_MEMORY_GET":
      return isNativeMemoryGetData(value.data);
    case "HOST_MEMORY_APPEND":
      return isNativeMemoryAppendData(value.data);
    case "HOST_MEMORY_CLEAR":
      return isNativeMemoryClearData(value.data);
    case "HOST_PUBLISH_EVIDENCE":
      return isNativePublishEvidenceData(value.data);
    case "HOST_CLEAR_EVIDENCE":
      return isNativeClearEvidenceData(value.data);
    case "HOST_TRANSCRIBE":
      return isNativeTranscribeData(value.data);
    case "HOST_COMPLETE":
      return isNativeCompleteData(value.data);
  }
}

export function isHostClientFailure(value: unknown): value is HostClientFailure {
  if (!isRecord(value)
    || value.ok !== false
    || !isHostClientErrorCode(value.code)
    || !isBoundedString(value.error, 1, NATIVE_MAX_ERROR_BYTES)
    || typeof value.retryable !== "boolean") return false;
  if (value.permissionNeeded !== undefined
    && (value.permissionNeeded !== true || value.code !== "PERMISSION_REQUIRED")) return false;
  return hasExactKeys(value, ["ok", "error", "code", "retryable"], ["permissionNeeded"]);
}

export function isHostHealthResponse(value: unknown): value is HostHealthResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && hasExactKeys(value, ["ok", "health"])
    && isNativeHealthData(value.health));
}

export function isHostConfigureResponse(value: unknown): value is HostConfigureResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && value.configured === true
    && hasExactKeys(value, ["ok", "configured"]));
}

export function isHostForgetResponse(value: unknown): value is HostForgetResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && value.configured === false
    && hasExactKeys(value, ["ok", "configured"]));
}

export function isHostCreateSessionResponse(value: unknown): value is HostCreateSessionResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && hasExactKeys(value, ["ok", "answerSdp"], ["upstreamRequestId"])
    && isSdp(value.answerSdp)
    && (value.upstreamRequestId === undefined || isOpaqueId(value.upstreamRequestId)));
}

export function isHostDisconnectResponse(value: unknown): value is HostDisconnectResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && hasExactKeys(value, ["ok"]));
}

export function isNativeHealthData(value: unknown): value is NativeHealthData {
  return isRecord(value)
    && value.ready === true
    && typeof value.configured === "boolean"
    && typeof value.claude === "boolean"
    && hasExactKeys(value, ["ready", "configured", "claude"], ["model"])
    && (value.model === undefined || isBoundedString(value.model, 1, NATIVE_MAX_MODEL_BYTES));
}

export function isNativeConfigureData(value: unknown): value is NativeConfigureData {
  return isRecord(value) && value.configured === true && hasExactKeys(value, ["configured"]);
}

export function isNativeForgetData(value: unknown): value is NativeForgetData {
  return isRecord(value) && value.configured === false && hasExactKeys(value, ["configured"]);
}

export function isNativeCreateSessionData(value: unknown): value is NativeCreateSessionData {
  return isRecord(value)
    && hasExactKeys(value, ["answerSdp"], ["upstreamRequestId"])
    && isSdp(value.answerSdp)
    && (value.upstreamRequestId === undefined || isOpaqueId(value.upstreamRequestId));
}

export function isNativeImportData(value: unknown): value is NativeImportData {
  return isRecord(value)
    && hasExactKeys(value, ["imported", "provider", "method", "configured"])
    && value.imported === true
    && isCredentialProvider(value.provider)
    && (value.method === "api_key" || value.method === "oauth")
    && typeof value.configured === "boolean";
}

export function isCredentialProvider(value: unknown): value is CredentialProvider {
  return value === "codex" || value === "claude-code";
}

export function isHostImportResponse(value: unknown): value is HostImportResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && hasExactKeys(value, ["ok", "imported", "provider", "method", "configured"])
    && value.imported === true
    && isCredentialProvider(value.provider)
    && (value.method === "api_key" || value.method === "oauth")
    && typeof value.configured === "boolean");
}

export function isNativeMemoryGetData(value: unknown): value is NativeMemoryGetData {
  return isRecord(value)
    && hasExactKeys(value, ["notes"])
    && Array.isArray(value.notes)
    && value.notes.length <= 50
    && value.notes.every(isSiteMemoryNote);
}

export function isNativeMemoryAppendData(value: unknown): value is NativeMemoryAppendData {
  return isRecord(value) && value.stored === true && hasExactKeys(value, ["stored"]);
}

export function isNativeMemoryClearData(value: unknown): value is NativeMemoryClearData {
  return isRecord(value) && value.cleared === true && hasExactKeys(value, ["cleared"]);
}

export function isSiteMemoryNote(value: unknown): value is SiteMemoryNote {
  return isRecord(value)
    && hasExactKeys(value, ["q", "a", "at"])
    && typeof value.q === "string" && value.q.length <= NATIVE_MAX_MEMORY_QUESTION_CHARS
    && typeof value.a === "string" && value.a.length <= NATIVE_MAX_MEMORY_ANSWER_CHARS
    && typeof value.at === "number" && Number.isFinite(value.at);
}

export function isHostMemoryGetResponse(value: unknown): value is HostMemoryGetResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && hasExactKeys(value, ["ok", "notes"])
    && Array.isArray(value.notes)
    && value.notes.length <= 50
    && value.notes.every(isSiteMemoryNote));
}

export function isHostMemoryAppendResponse(value: unknown): value is HostMemoryAppendResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && value.stored === true
    && hasExactKeys(value, ["ok", "stored"]));
}

export function isHostMemoryClearResponse(value: unknown): value is HostMemoryClearResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && value.cleared === true
    && hasExactKeys(value, ["ok", "cleared"]));
}

export function isNativePublishEvidenceData(value: unknown): value is NativePublishEvidenceData {
  return isRecord(value) && value.published === true && hasExactKeys(value, ["published"]);
}

export function isNativeClearEvidenceData(value: unknown): value is NativeClearEvidenceData {
  return isRecord(value) && value.cleared === true && hasExactKeys(value, ["cleared"]);
}

export function isHostPublishEvidenceResponse(value: unknown): value is HostPublishEvidenceResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && value.published === true
    && hasExactKeys(value, ["ok", "published"]));
}

export function isHostClearEvidenceResponse(value: unknown): value is HostClearEvidenceResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && value.cleared === true
    && hasExactKeys(value, ["ok", "cleared"]));
}

export function isNativeTranscribeData(value: unknown): value is NativeTranscribeData {
  return isRecord(value)
    && hasExactKeys(value, ["transcript"])
    && typeof value.transcript === "string"
    && value.transcript.length >= 1
    && value.transcript.length <= 4_000;
}

export function isNativeCompleteData(value: unknown): value is NativeCompleteData {
  return isRecord(value)
    && hasExactKeys(value, ["content", "stopReason"])
    && isCompletionResponseContent(value.content)
    && typeof value.stopReason === "string"
    && value.stopReason.length <= 40;
}

export function isHostTranscribeResponse(value: unknown): value is HostTranscribeResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && hasExactKeys(value, ["ok", "transcript"])
    && typeof value.transcript === "string"
    && value.transcript.length >= 1
    && value.transcript.length <= 4_000);
}

export function isHostCompleteResponse(value: unknown): value is HostCompleteResponse | HostClientFailure {
  return isHostClientFailure(value) || (isRecord(value)
    && value.ok === true
    && hasExactKeys(value, ["ok", "content", "stopReason"])
    && isCompletionResponseContent(value.content)
    && typeof value.stopReason === "string"
    && value.stopReason.length <= 40);
}

function isTranscribeAudio(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 60
    && value.length <= NATIVE_MAX_TRANSCRIBE_AUDIO_B64_CHARS
    // RIFF little-endian magic in base64; full validation happens host-side.
    && value.startsWith("UklGR")
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isCompletionTextBlock(value: unknown): value is CompletionTextBlock {
  return isRecord(value)
    && hasExactKeys(value, ["type", "text"])
    && value.type === "text"
    && typeof value.text === "string"
    && value.text.length >= 1
    && value.text.length <= NATIVE_MAX_COMPLETION_TEXT_CHARS;
}

function isCompletionToolUseBlock(value: unknown): value is CompletionToolUseBlock {
  return isRecord(value)
    && hasExactKeys(value, ["type", "id", "name", "input"])
    && value.type === "tool_use"
    && typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 200
    && (value.name === "show_guidance" || value.name === "clear_guidance")
    && isRecord(value.input);
}

function isCompletionToolResultBlock(value: unknown): value is CompletionToolResultBlock {
  return isRecord(value)
    && hasExactKeys(value, ["type", "tool_use_id", "content"])
    && value.type === "tool_result"
    && typeof value.tool_use_id === "string" && value.tool_use_id.length >= 1 && value.tool_use_id.length <= 200
    && typeof value.content === "string"
    && value.content.length <= NATIVE_MAX_TOOL_RESULT_CHARS;
}

export function isCompletionMessages(value: unknown): value is CompletionMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > NATIVE_MAX_COMPLETION_MESSAGES) return false;
  return value.every((message) => isRecord(message)
    && hasExactKeys(message, ["role", "content"])
    && (message.role === "user" || message.role === "assistant")
    && Array.isArray(message.content)
    && message.content.length >= 1
    && message.content.length <= NATIVE_MAX_COMPLETION_BLOCKS
    && message.content.every((block) => isCompletionTextBlock(block)
      || isCompletionToolUseBlock(block)
      || isCompletionToolResultBlock(block)));
}

export function isCompletionResponseContent(value: unknown): value is CompletionResponseBlock[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= NATIVE_MAX_COMPLETION_BLOCKS
    && value.every((block) => isCompletionTextBlock(block) || isCompletionToolUseBlock(block));
}

export function isWebOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > NATIVE_MAX_ORIGIN_CHARS) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && parsed.hostname.length > 0
    && (parsed.pathname === "" || parsed.pathname === "/")
    && parsed.search === ""
    && parsed.hash === ""
    && parsed.username === ""
    && parsed.password === "";
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isNativeHostError(value: unknown): value is NativeHostError {
  return isRecord(value)
    && hasExactKeys(value, ["code", "message", "retryable"])
    && isNativeHostErrorCode(value.code)
    && isBoundedString(value.message, 1, NATIVE_MAX_ERROR_BYTES)
    && typeof value.retryable === "boolean";
}

function isNativeHostErrorCode(value: unknown): value is NativeHostErrorCode {
  return typeof value === "string" && (NATIVE_HOST_ERROR_CODES as readonly string[]).includes(value);
}

function isHostClientErrorCode(value: unknown): value is HostClientErrorCode {
  return isNativeHostErrorCode(value)
    || value === "PERMISSION_REQUIRED"
    || value === "HOST_NOT_FOUND"
    || value === "HOST_DISCONNECTED"
    || value === "TIMEOUT"
    || value === "INVALID_RESPONSE";
}

function isSessionMode(value: unknown): value is RealtimeSessionMode {
  return value === "text" || value === "voice";
}

function isMemoryText(value: unknown, maximumChars: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximumChars;
}

function isEvidenceTitle(value: unknown): value is string {
  return typeof value === "string" && value.length <= NATIVE_MAX_EVIDENCE_TITLE_CHARS;
}

function isEvidenceText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= NATIVE_MAX_EVIDENCE_CHARS;
}

function isApiKey(value: unknown): value is string {
  return typeof value === "string"
    && /^sk-[A-Za-z0-9_-]{20,500}$/.test(value)
    && utf8ByteLength(value) <= NATIVE_MAX_API_KEY_BYTES;
}

function isSdp(value: unknown): value is string {
  return typeof value === "string"
    && /^v=0(?:\r\n|\n)/.test(value)
    && utf8ByteLength(value) <= NATIVE_MAX_SDP_BYTES;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isBoundedString(value: unknown, minimumBytes: number, maximumBytes: number): value is string {
  if (typeof value !== "string") return false;
  const length = utf8ByteLength(value);
  return length >= minimumBytes && length <= maximumBytes;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function fitsJsonSize(value: unknown, maximumBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && utf8ByteLength(serialized) <= maximumBytes;
  } catch {
    return false;
  }
}
