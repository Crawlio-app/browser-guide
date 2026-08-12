import type { ShowGuidanceCommand } from "../../shared/assistant-contract.js";
import type { PageContext, PageElementCandidate } from "../../shared/page-context.js";

/**
 * The canned practice tour: a scripted walkthrough of the hosted practice page
 * that runs with no model, no network, and no native helper. Steps are matched
 * against fresh page evidence on every advance — refs never survive a
 * recapture, so matchers, not refs, are the durable identity of a step.
 */
export interface DemoStepSpec {
  match: { role: string; nameIncludes: string };
  title: string;
  body: string;
}

export const DEMO_TOUR_GOAL = "Practice tour";

const PRACTICE_TITLE_PREFIX = "Browser Guide Practice";
const PRACTICE_MARKER_NAME = "Browser Guide practice page";

export const DEMO_TOUR_STEPS: readonly DemoStepSpec[] = [
  {
    match: { role: "heading", nameIncludes: "Welcome to the practice space" },
    title: "This is a guided tour",
    body: "Browser Guide explains pages and points at controls. It never clicks or types. Press Next on each card to continue.",
  },
  {
    match: { role: "navigation", nameIncludes: "Practice navigation" },
    title: "Finding your way",
    body: "Ask where something lives and the guide points at the right place — like this navigation. You stay in charge of every click.",
  },
  {
    match: { role: "searchbox", nameIncludes: "Search invoices" },
    title: "Inputs stay yours",
    body: "The guide can point at a field like this search box, but it can never type into it. Whatever you enter stays on the page.",
  },
  {
    match: { role: "button", nameIncludes: "Review invoices" },
    title: "The pointer beacon",
    body: "In Find mode, describe a control and a beacon lands on the best match — like this button. Dismiss it anytime.",
  },
  {
    match: { role: "button", nameIncludes: "Download yearly statement" },
    title: "Off-screen? No problem",
    body: "This button sits below the fold. When a target is off-screen, press the arrow on the card and the page scrolls to it.",
  },
  {
    match: { role: "link", nameIncludes: "Read the full guide" },
    title: "That is the whole trick",
    body: "Eyes, never hands. Connect the local helper to ask real questions on any site — or read the full guide right here.",
  },
];

export function isPracticePage(context: PageContext): boolean {
  const titled = context.title.startsWith(PRACTICE_TITLE_PREFIX);
  const marked = context.elements.some((element) => element.name === PRACTICE_MARKER_NAME);
  return (titled || marked) && resolveDemoStep(context, 0) !== null;
}

export function resolveDemoStep(context: PageContext, index: number): ShowGuidanceCommand | null {
  const step = DEMO_TOUR_STEPS[index];
  if (!step) return null;
  const target = findMatch(context.elements, step);
  if (!target) return null;
  return {
    name: "show_guidance",
    refs: [target.ref],
    title: step.title,
    body: step.body,
    presentation: "step",
    waitFor: "user_confirm",
    progress: { current: index + 1, total: DEMO_TOUR_STEPS.length },
  };
}

function findMatch(elements: readonly PageElementCandidate[], step: DemoStepSpec): PageElementCandidate | null {
  const wanted = step.match.nameIncludes.toLowerCase();
  const candidates = elements.filter((element) => (
    element.role === step.match.role
    && element.name.toLowerCase().includes(wanted)
  ));
  if (candidates.length === 0) return null;
  // Prefer enabled, on-screen, unoccluded targets — but accept off-viewport
  // ones: the overlay's take-me-there arrow exists exactly for those.
  return [...candidates].sort((left, right) => (
    rank(left) - rank(right)
    || (left.occlusionConfidence ?? 0) - (right.occlusionConfidence ?? 0)
  ))[0] ?? null;
}

function rank(element: PageElementCandidate): number {
  if (element.disabled) return 2;
  return element.visibility === "visible" ? 0 : 1;
}
