// Node mirrors of FileCredentialStore.swift, SiteMemoryStore.swift, and
// SharedEvidenceStore.swift: same file locations, same env overrides, same
// bounds, same permissions, and the same user-facing error messages.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export class CredentialStoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // "ioFailure" | "malformedStore" | "importSourceMissing" | "importSourceInvalid"
  }
}

function configPath(envName, fallback) {
  const override = process.env[envName];
  if (override) return override;
  return join(homedir(), ".config", "browser-guide", fallback);
}

function writePrivateJson(path, object) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.staging-${process.pid}`;
  writeFileSync(staging, JSON.stringify(object, null, 2), { mode: 0o600 });
  renameSync(staging, path);
  chmodSync(path, 0o600);
}

/** Five minutes, matching the early-expiry buffer the Swift store uses. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1_000;

/** The panel renders these as text, so bound them and reject control
 *  characters before they can smuggle line breaks into the UI. */
function identityText(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return undefined;
  return /[\u0000-\u001f\u007f]/.test(trimmed) ? undefined : trimmed;
}

function trimAccount(account) {
  const result = { provider: account.provider };
  const label = identityText(account.label);
  const plan = identityText(account.plan);
  if (label) result.label = label;
  if (plan) result.plan = plan;
  if (typeof account.expiresAt === "number" && account.expiresAt > 0) result.expiresAt = account.expiresAt;
  return result;
}

function sourceFrom(account, available, detail) {
  const source = { provider: account.provider, available };
  if (account.label) source.label = account.label;
  if (account.plan) source.plan = account.plan;
  if (account.expiresAt) source.expiresAt = account.expiresAt;
  if (detail) source.detail = detail;
  return source;
}

/** Codex writes the ChatGPT id_token beside the API key. Its payload names the
 *  signed-in account, which is the only way to confirm which account was
 *  connected. The signature is not verified and never trusted for
 *  authorization: this is a label on a file the user already owns. */
function codexAccount(authObject) {
  const idToken = authObject?.tokens?.id_token;
  const claims = typeof idToken === "string" ? decodeJwtClaims(idToken) : null;
  if (!claims) return { provider: "codex" };
  return trimAccount({
    provider: "codex",
    label: claims.email ?? claims.preferred_username,
    plan: claims["https://api.openai.com/auth"]?.chatgpt_plan_type,
  });
}

/** The access token expires hourly and Claude Code refreshes it in the
 *  background, so surfacing that would cry wolf. The refresh token's expiry is
 *  the moment a person genuinely has to sign in again. */
function claudeAccount(oauth) {
  return trimAccount({
    provider: "claude-code",
    plan: oauth?.subscriptionType,
    expiresAt: oauth?.refreshTokenExpiresAt,
  });
}

function decodeJwtClaims(token) {
  const segments = token.split(".");
  if (segments.length < 2) return null;
  try {
    const payload = Buffer.from(segments[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(payload);
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

export class FileCredentialStore {
  constructor(storeUrl = configPath("BROWSER_GUIDE_CREDENTIALS_PATH", "credentials.json"), homeDirectory = homedir()) {
    this.storeUrl = storeUrl;
    this.homeDirectory = homeDirectory;
  }

  #load() {
    if (!existsSync(this.storeUrl)) return null;
    let raw;
    try {
      raw = readFileSync(this.storeUrl, "utf8");
    } catch {
      throw new CredentialStoreError("ioFailure", "The credential store could not be read.");
    }
    let object;
    try {
      object = JSON.parse(raw);
    } catch {
      throw new CredentialStoreError("malformedStore", "malformed");
    }
    if (typeof object !== "object" || object === null || Array.isArray(object)) {
      throw new CredentialStoreError("malformedStore", "malformed");
    }
    return object;
  }

  #persist(store) {
    try {
      writePrivateJson(this.storeUrl, { ...store, version: 1 });
    } catch {
      throw new CredentialStoreError("ioFailure", "The credential store could not be written.");
    }
  }

  #upsert(provider, credential) {
    const store = this.#load() ?? {};
    store.version = 1;
    store[provider] = credential;
    this.#persist(store);
  }

  readApiKey() {
    const store = this.#load();
    if (!store) return null;
    const openai = store.openai;
    if (typeof openai !== "object" || openai === null) return null;
    return typeof openai.key === "string" ? openai.key : null;
  }

  saveApiKey(apiKey) {
    this.#upsert("openai", { type: "api_key", key: apiKey, source: "manual" });
  }

  deleteApiKey() {
    const store = this.#load() ?? {};
    delete store.openai;
    this.#persist(store);
  }

  importCredentials(provider) {
    return provider === "codex" ? this.#importCodex() : this.#importClaudeCode();
  }

  #importCodex() {
    const authPath = join(this.homeDirectory, ".codex", "auth.json");
    if (!existsSync(authPath)) {
      throw new CredentialStoreError("importSourceMissing", "No Codex sign-in was found (~/.codex/auth.json). Run `codex login` first.");
    }
    let object;
    try {
      object = JSON.parse(readFileSync(authPath, "utf8"));
    } catch {
      throw new CredentialStoreError("importSourceInvalid", "The Codex sign-in file could not be read. Run `codex login` again.");
    }
    const apiKey = object?.OPENAI_API_KEY;
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw new CredentialStoreError("importSourceInvalid", "Your Codex sign-in has no API key. Run `codex login` and choose the API-key option, or paste a key manually.");
    }
    const account = codexAccount(object);
    const credential = { type: "api_key", key: apiKey, source: "codex-cli" };
    if (account.label) credential.label = account.label;
    if (account.plan) credential.plan = account.plan;
    this.#upsert("openai", credential);
    return { provider: "codex", method: "api_key", configured: true, account };
  }

  #importClaudeCode() {
    const credentialsPath = join(this.homeDirectory, ".claude", ".credentials.json");
    let data = null;
    if (existsSync(credentialsPath)) {
      try {
        data = readFileSync(credentialsPath, "utf8");
      } catch {
        data = null;
      }
    }
    if (data === null) data = readClaudeCodeKeychain();
    if (data === null) {
      throw new CredentialStoreError("importSourceMissing", "No Claude Code sign-in was found (checked the login Keychain and ~/.claude/.credentials.json). Run `claude` and sign in first.");
    }
    let oauth;
    try {
      oauth = JSON.parse(data)?.claudeAiOauth;
    } catch {
      oauth = null;
    }
    if (typeof oauth?.accessToken !== "string" || oauth.accessToken.length === 0) {
      throw new CredentialStoreError("importSourceInvalid", "The Claude Code sign-in could not be read. Sign in to Claude Code again.");
    }
    const account = claudeAccount(oauth);
    const credential = { type: "oauth", access: oauth.accessToken, source: "claude-code" };
    if (typeof oauth.refreshToken === "string") credential.refresh = oauth.refreshToken;
    if (typeof oauth.expiresAt === "number") credential.expires = oauth.expiresAt;
    if (account.plan) credential.plan = account.plan;
    if (account.expiresAt) credential.signInExpires = account.expiresAt;
    this.#upsert("anthropic", credential);
    return { provider: "claude-code", method: "oauth", configured: this.readApiKey() !== null, account };
  }

  /** Who the stored credentials belong to, read from the store we already own
   *  so health never has to touch the harness sources. */
  storedAccount() {
    let store;
    try {
      store = this.#load();
    } catch {
      return null;
    }
    if (!store) return null;
    const openai = store.openai;
    if (openai && typeof openai.key === "string") {
      if (openai.source !== "codex-cli") return { provider: "codex" };
      return trimAccount({ provider: "codex", label: openai.label, plan: openai.plan });
    }
    const anthropic = store.anthropic;
    if (!anthropic || typeof anthropic.access !== "string") return null;
    return trimAccount({ provider: "claude-code", plan: anthropic.plan, expiresAt: anthropic.signInExpires });
  }

  /** Which harness sign-ins this computer actually has, so the setup screen can
   *  lead with the one that is there. */
  availableSources() {
    return [this.#codexSource(), this.#claudeCodeSource()];
  }

  #codexSource() {
    const authPath = join(this.homeDirectory, ".codex", "auth.json");
    if (!existsSync(authPath)) {
      return { provider: "codex", available: false, detail: "Run `codex login` to create one." };
    }
    let object;
    try {
      object = JSON.parse(readFileSync(authPath, "utf8"));
    } catch {
      return { provider: "codex", available: false, detail: "The Codex sign-in file could not be read." };
    }
    const account = codexAccount(object);
    const apiKey = object?.OPENAI_API_KEY;
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return sourceFrom(account, false, "This Codex sign-in carries no API key.");
    }
    return sourceFrom(account, true);
  }

  #claudeCodeSource() {
    const credentialsPath = join(this.homeDirectory, ".claude", ".credentials.json");
    let data = null;
    if (existsSync(credentialsPath)) {
      try {
        data = readFileSync(credentialsPath, "utf8");
      } catch {
        data = null;
      }
    }
    if (data === null) data = readClaudeCodeKeychain();
    if (data === null) {
      return { provider: "claude-code", available: false, detail: "Sign in to Claude Code to create one." };
    }
    let oauth;
    try {
      oauth = JSON.parse(data)?.claudeAiOauth;
    } catch {
      oauth = null;
    }
    if (typeof oauth?.accessToken !== "string" || oauth.accessToken.length === 0) {
      return { provider: "claude-code", available: false, detail: "The Claude Code sign-in could not be read." };
    }
    return sourceFrom(claudeAccount(oauth), true);
  }

  hasAnthropicCredential() {
    try {
      return typeof this.#load()?.anthropic?.access === "string";
    } catch {
      return false;
    }
  }

  /** A non-expired Claude access token, re-synced from the source file when
   *  the stored copy is near expiry. Never runs an OAuth refresh of our own. */
  freshAnthropicAccessToken(nowMs = Date.now()) {
    let anthropic;
    try {
      anthropic = this.#load()?.anthropic;
    } catch {
      return null;
    }
    if (typeof anthropic?.access !== "string") return null;
    const expired = (credential) => typeof credential.expires === "number"
      && nowMs >= credential.expires - TOKEN_EXPIRY_BUFFER_MS;
    if (expired(anthropic)) {
      try {
        this.#importClaudeCode();
        anthropic = this.#load()?.anthropic;
      } catch {
        // Fall through to the expiry check below with the stale copy.
      }
      if (!anthropic || expired(anthropic)) {
        throw new CredentialStoreError(
          "importSourceInvalid",
          "Your Claude sign-in expired. Open Claude Code once to refresh it, then try again.",
        );
      }
    }
    return typeof anthropic.access === "string" ? anthropic.access : null;
  }

  /** Re-reads the Codex source once; true when a rotated key replaced ours. */
  resyncOpenAiCredentialFromSource() {
    let store;
    try {
      store = this.#load();
    } catch {
      return false;
    }
    const openai = store?.openai;
    if (openai?.source !== "codex-cli" || typeof openai.key !== "string") return false;
    const previousKey = openai.key;
    try {
      this.#importCodex();
    } catch {
      return false;
    }
    try {
      const refreshedKey = this.#load()?.openai?.key;
      return typeof refreshedKey === "string" && refreshedKey !== previousKey;
    } catch {
      return false;
    }
  }
}

/** macOS keeps the Claude Code sign-in in login Keychain items prefixed
 *  "Claude Code-credentials" (per-profile suffixes; some hold only MCP-server
 *  tokens). Enumerate, read individually, keep the freshest sign-in. */
function readClaudeCodeKeychain() {
  if (process.platform !== "darwin") return null;
  let dump;
  try {
    dump = execFileSync("/usr/bin/security", ["dump-keychain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  // Service names repeat across items (an old mcpOAuth-only item shares the
  // base name with the real sign-in): enumerate (service, account) pairs.
  const candidates = new Set();
  for (const block of dump.split("keychain: ")) {
    if (!block.includes("Claude Code-credentials")) continue;
    const service = block.match(/"svce"<blob>="(Claude Code-credentials[^"]*)"/);
    const account = block.match(/"acct"<blob>="([^"]*)"/);
    if (service && account) candidates.add(JSON.stringify([service[1], account[1]]));
  }
  let freshest = null;
  for (const pair of candidates) {
    const [service, account] = JSON.parse(pair);
    let payload;
    try {
      payload = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      continue;
    }
    try {
      const oauth = JSON.parse(payload)?.claudeAiOauth;
      if (typeof oauth?.accessToken !== "string") continue;
      const expires = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
      if (!freshest || expires > freshest.expires) freshest = { expires, payload };
    } catch {
      continue;
    }
  }
  return freshest?.payload ?? null;
}

export class SiteMemoryStore {
  static maxNotesPerOrigin = 10;
  static maxOrigins = 50;
  static maxQuestionLength = 300;
  static maxAnswerLength = 500;

  constructor(storeUrl = configPath("BROWSER_GUIDE_MEMORY_PATH", "memory.json")) {
    this.storeUrl = storeUrl;
  }

  #load() {
    if (!existsSync(this.storeUrl)) return null;
    try {
      const object = JSON.parse(readFileSync(this.storeUrl, "utf8"));
      return typeof object === "object" && object !== null && !Array.isArray(object) ? object : null;
    } catch {
      // Damaged memory is disposable: start fresh rather than fail requests.
      return null;
    }
  }

  #persist(store) {
    try {
      writePrivateJson(this.storeUrl, store);
    } catch {
      throw new CredentialStoreError("ioFailure", "The site memory store could not be written.");
    }
  }

  notes(origin) {
    const notes = this.#load()?.[origin]?.notes;
    return Array.isArray(notes) ? notes : [];
  }

  append(origin, question, answer, nowSeconds = Date.now() / 1000) {
    const store = this.#load() ?? {};
    const site = typeof store[origin] === "object" && store[origin] !== null ? store[origin] : {};
    const notes = Array.isArray(site.notes) ? site.notes : [];
    notes.push({
      q: question.slice(0, SiteMemoryStore.maxQuestionLength),
      a: answer.slice(0, SiteMemoryStore.maxAnswerLength),
      at: nowSeconds,
    });
    site.notes = notes.slice(-SiteMemoryStore.maxNotesPerOrigin);
    site.updatedAt = nowSeconds;
    store[origin] = site;

    const origins = Object.keys(store).filter((key) => key.startsWith("http"));
    if (origins.length > SiteMemoryStore.maxOrigins) {
      const sorted = origins.sort((left, right) => (store[left]?.updatedAt ?? 0) - (store[right]?.updatedAt ?? 0));
      for (const stale of sorted.slice(0, origins.length - SiteMemoryStore.maxOrigins)) {
        delete store[stale];
      }
    }
    this.#persist(store);
  }

  clear(origin) {
    if (origin !== null) {
      const store = this.#load() ?? {};
      delete store[origin];
      this.#persist(store);
    } else {
      rmSync(this.storeUrl, { force: true });
    }
  }
}

export class SharedEvidenceStore {
  static maxTitleLength = 300;
  static maxEvidenceLength = 200_000;

  constructor(storeUrl = configPath("BROWSER_GUIDE_EYES_PATH", "eyes.json")) {
    this.storeUrl = storeUrl;
  }

  publish(origin, title, evidence, nowSeconds = Date.now() / 1000) {
    try {
      writePrivateJson(this.storeUrl, {
        version: 1,
        origin,
        title: title.slice(0, SharedEvidenceStore.maxTitleLength),
        evidence: evidence.slice(0, SharedEvidenceStore.maxEvidenceLength),
        captured_at: nowSeconds,
      });
    } catch {
      throw new CredentialStoreError("ioFailure", "The shared evidence snapshot could not be written.");
    }
  }

  clear() {
    rmSync(this.storeUrl, { force: true });
  }
}
