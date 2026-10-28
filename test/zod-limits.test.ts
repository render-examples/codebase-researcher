import { describe, expect, it } from "vitest";
import { MESSAGE_MAX_CHARS, Transcript, TRANSCRIPT_MAX_MESSAGES } from "../src/investigation.ts";

describe("Transcript validation limits", () => {
  it("rejects an oversized transcript without allocating per-message validation issues", () => {
    const input = Array.from({ length: 1_000 }, () => ({ role: "invalid", text: 42 }));
    const parsed = Transcript.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("oversized transcript was accepted");

    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0]).toMatchObject({ code: "too_big", path: [], maximum: TRANSCRIPT_MAX_MESSAGES });
  });

  it.each([1, TRANSCRIPT_MAX_MESSAGES])("accepts a valid transcript containing %i messages", (length) => {
    const input = Array.from({ length }, () => ({ role: "user" as const, text: "x".repeat(MESSAGE_MAX_CHARS) }));
    expect(Transcript.parse(input)).toEqual(input);
  });

  it("still rejects an empty transcript", () => {
    const parsed = Transcript.safeParse([]);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("empty transcript was accepted");
    expect(parsed.error.issues).toMatchObject([{ code: "too_small", path: [], minimum: 1 }]);
  });

  it("still validates individual messages within the transcript limit", () => {
    const parsed = Transcript.safeParse([{ role: "invalid", text: 42 }]);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("invalid message was accepted");
    expect(parsed.error.issues.map(({ path }) => path)).toEqual([[0, "role"], [0, "text"]]);
  });
});
