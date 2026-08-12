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

export const NATIVE_TIMEOUT_MS = {
  connect: 3_000,
  health: 3_000,
  configure: 8_000,
  forget: 8_000,
  createSession: 30_000,
} as const;

export type NativeRequestType = "HOST_HEALTH" | "HOST_CONFIGURE_KEY" | "HOST_FORGET_KEY" | "HOST_CREATE_SESSION";
export type RealtimeSessionMode = "text" | "voice";

export type NativeHostRequest =
  | { version: 1; requestId: string; type: "HOST_HEALTH" }
  | { version: 1; requestId: string; type: "HOST_CONFIGURE_KEY"; payload: { key: string } }
  | { version: 1; requestId: string; type: "HOST_FORGET_KEY" }
  | { version: 1; requestId: string; type: "HOST_CREATE_SESSION"; payload: { sdp: string; mode: RealtimeSessionMode } };

export interface NativeHealthData {
  ready: true;
  configured: boolean;
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

export type NativeSuccessData =
  | NativeHealthData
  | NativeConfigureData
  | NativeForgetData
  | NativeCreateSessionData;

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

export interface HostDisconnectResponse {
  ok: true;
}

export type HostClientResponse = HostClientFailure
  | HostHealthResponse
  | HostConfigureResponse
  | HostForgetResponse
  | HostCreateSessionResponse
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
    && hasExactKeys(value, ["ready", "configured"], ["model"])
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
