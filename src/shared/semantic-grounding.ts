import type { PageElementCandidate } from "./page-context.js";

export interface GroundingResult {
  ref: string;
  score: number;
  reasons: string[];
}

const ROLE_HINTS: Record<string, string[]> = {
  button: ["button", "press", "choose", "open", "continue", "save", "start"],
  link: ["link", "go", "visit", "navigate", "open"],
  textbox: ["field", "input", "enter", "search", "type"],
  heading: ["heading", "title", "section"],
  navigation: ["navigation", "menu", "nav"],
  checkbox: ["checkbox", "check", "option"],
};

export function groundElements(query: string, candidates: PageElementCandidate[], limit = 5): GroundingResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];
  return candidates
    .map((candidate) => scoreCandidate(queryTokens, candidate))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || numericRef(left.ref) - numericRef(right.ref))
    .slice(0, Math.max(0, Math.min(limit, 20)));
}

function scoreCandidate(queryTokens: Set<string>, candidate: PageElementCandidate): GroundingResult {
  const reasons: string[] = [];
  let score = 0;
  const nameMatches = overlap(queryTokens, tokenize(candidate.name));
  const textMatches = overlap(queryTokens, tokenize(candidate.text ?? ""));
  const sectionMatches = overlap(queryTokens, tokenize(candidate.section));
  if (nameMatches > 0) {
    score += nameMatches * 5;
    reasons.push(`name:${nameMatches}`);
  }
  if (textMatches > 0) {
    score += textMatches * 2;
    reasons.push(`text:${textMatches}`);
  }
  if (sectionMatches > 0) {
    score += sectionMatches * 1.5;
    reasons.push(`section:${sectionMatches}`);
  }
  const roleHints = ROLE_HINTS[candidate.role] ?? [candidate.role];
  if (roleHints.some((hint) => queryTokens.has(hint))) {
    score += 2;
    reasons.push(`role:${candidate.role}`);
  }
  if (score > 0 && candidate.visibility === "visible") {
    score += 0.5;
    reasons.push("visible");
  }
  return { ref: candidate.ref, score, reasons };
}

function tokenize(input: string): Set<string> {
  return new Set(input.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((token) => token.length > 1));
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function numericRef(ref: string): number {
  const value = Number(ref.slice(1));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
