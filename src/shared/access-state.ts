import type { ExtensionRuntimeState, PermissionPauseReason } from "./protocol.js";

export interface ActiveTabEvidence {
  tabId?: number;
  rawUrl?: string;
}

export function assessActiveTabAccess(
  state: ExtensionRuntimeState,
  tab: ActiveTabEvidence,
): PermissionPauseReason | null {
  if (tab.tabId === undefined || tab.tabId !== state.tabId) return "not-authorized";
  if (tab.rawUrl === undefined) return "access-lost";
  const origin = webOrigin(tab.rawUrl);
  if (!origin) return "restricted-page";
  if (!state.authorizedOrigin || origin !== state.authorizedOrigin) return "origin-changed";
  if (state.status !== "ready") return state.pauseReason ?? "access-lost";
  return null;
}

export function webOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
