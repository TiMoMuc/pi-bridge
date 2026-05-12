import { describe, expect, it } from "vitest";
import { parseReactionTags, stripReactionTags } from "../src/transports/signal-reaction-tags.js";

describe("signal reaction tags", () => {
  it("parses explicit reaction tags", () => {
    expect(parseReactionTags("Thanks [REACT:👍 abcd1234]")).toEqual([
      { emoji: "👍", sessionMessageId: "abcd1234" },
    ]);
  });

  it("deduplicates identical tags", () => {
    expect(parseReactionTags("[REACT:👍 abcd1234] [REACT:👍 abcd1234]")).toHaveLength(1);
  });

  it("strips reaction tags from visible text", () => {
    expect(stripReactionTags("Hello\n\n[REACT:👍 abcd1234]")) .toBe("Hello");
  });
});
