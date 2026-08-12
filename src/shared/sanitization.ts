import type { PageContext, PageElementCandidate } from "./page-context.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:^|[_-])(pass(?:word)?|secret|token|authorization|auth|cookie|session|api[_-]?key|private[_-]?key|client[_-]?secret)(?:$|[_-])/i;
const TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*[^\s,;"']{8,}/gi,
];

export function redactText(input: string, maxLength = 2_000): string {
  let output = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  for (const pattern of TEXT_PATTERNS) output = output.replace(pattern, REDACTED);
  output = output.replace(/<\/?system-reminder\b[^>]*>/gi, "");
  output = output.replace(/---\s*(?:END_)?BROWSER_GUIDE_[^-\n]*---/gi, "[untrusted marker removed]");
  return output.length > maxLength ? `${output.slice(0, maxLength - 1)}…` : output;
}

export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.hash = "";
    // Query strings routinely carry OAuth codes, signed-URL credentials, and
    // application secrets under arbitrary names. They are never needed for
    // grounding, so omit the entire query rather than trying to enumerate keys.
    url.search = "";
    url.pathname = url.pathname.split("/").map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        decoded = segment;
      }
      return encodeURIComponent(redactText(decoded, 500));
    }).join("/");
    return url.toString().slice(0, 2_048);
  } catch {
    return redactText(rawUrl, 2_048);
  }
}

export function sanitizeOrigin(rawOrigin: string): string {
  try {
    const url = new URL(rawOrigin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "null";
    return url.origin.slice(0, 2_048);
  } catch {
    return "null";
  }
}

export function sanitizePageContext(context: PageContext): PageContext {
  const elements = context.elements.slice(0, 300).map(sanitizeElement);
  return {
    ...context,
    title: redactText(context.title, 240),
    url: sanitizeUrl(context.url),
    origin: sanitizeOrigin(context.origin),
    elements,
    screenshotDataUrl: isAllowedScreenshot(context.screenshotDataUrl) ? context.screenshotDataUrl : undefined,
  };
}

export function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeUnknown(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 500)) {
    output[key] = SENSITIVE_KEY.test(`_${key}_`) ? REDACTED : sanitizeUnknown(nested, depth + 1);
  }
  return output;
}

function sanitizeElement(element: PageElementCandidate): PageElementCandidate {
  return {
    ...element,
    ref: /^e[1-9][0-9]*$/.test(element.ref) ? element.ref : "invalid-ref",
    role: redactText(element.role, 40),
    name: redactText(element.name, 160),
    text: element.text ? redactText(element.text, 180) : undefined,
    section: redactText(element.section, 120),
  };
}

function isAllowedScreenshot(value: string | undefined): value is string {
  return typeof value === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 1_500_000;
}
