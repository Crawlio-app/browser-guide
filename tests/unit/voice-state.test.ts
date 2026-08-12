import { describe, expect, it } from "vitest";
import { reduceVoiceState } from "../../src/extension/sidepanel/voice-session.js";

describe("voice state recovery", () => {
  it("moves through listening, thinking, speaking, and back to idle", () => {
    let state = reduceVoiceState("idle", "speech-started");
    expect(state).toBe("listening");
    state = reduceVoiceState(state, "speech-stopped");
    expect(state).toBe("thinking");
    state = reduceVoiceState(state, "audio-started");
    expect(state).toBe("speaking");
    state = reduceVoiceState(state, "response-done");
    expect(state).toBe("idle");
  });

  it("does not recover out of a permission-paused state", () => {
    expect(reduceVoiceState("permission-paused", "recover")).toBe("permission-paused");
  });
});
