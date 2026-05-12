import { describe, expect, it } from "vitest";
import {
  parseAttachmentPaths,
  parseOutboundControl,
  parseReactionTags,
  stripAttachmentTags,
  stripReactionTags,
} from "../src/outbound-control.js";

describe("outbound control parsing", () => {
  it("lets wait() win over visible text and other outbound control tags", () => {
    expect(
      parseOutboundControl(
        "Here you go [REACT:👍 abcd1234]\n\nSee [ATTACH:/tmp/report.pdf]",
        { waitCalled: true },
      ),
    ).toEqual({
      rawText: "Here you go [REACT:👍 abcd1234]\n\nSee [ATTACH:/tmp/report.pdf]",
      silent: true,
      visibleText: "",
      reactions: [],
      attachmentPaths: [],
    });
  });

  it("parses reaction and attachment tags through one shared pass", () => {
    const parsed = parseOutboundControl(
      "Here you go [REACT:👍 abcd1234]\n\nPlease review [ATTACH:/workspace/work/report.pdf] today",
    );

    expect(parsed.silent).toBe(false);
    expect(parsed.reactions).toEqual([{ emoji: "👍", sessionMessageId: "abcd1234" }]);
    expect(parsed.attachmentPaths).toEqual(["/workspace/work/report.pdf"]);
    expect(parsed.visibleText).toBe("Here you go\n\nPlease review report.pdf today");
  });

  it("produces empty visible text for reaction-only output", () => {
    const parsed = parseOutboundControl("[REACT:👍 abcd1234]");
    expect(parsed.silent).toBe(false);
    expect(parsed.visibleText).toBe("");
    expect(parsed.reactions).toEqual([{ emoji: "👍", sessionMessageId: "abcd1234" }]);
  });
});

describe("outbound control helpers", () => {
  it("deduplicates identical reaction tags", () => {
    expect(parseReactionTags("[REACT:👍 abcd1234] [REACT:👍 abcd1234]")).toEqual([
      { emoji: "👍", sessionMessageId: "abcd1234" },
    ]);
  });

  it("deduplicates identical attachment tags", () => {
    expect(parseAttachmentPaths("[ATTACH:/tmp/a.txt] [ATTACH:/tmp/a.txt]")).toEqual([
      "/tmp/a.txt",
    ]);
  });

  it("strips reaction tags from visible text", () => {
    expect(stripReactionTags("Hello\n\n[REACT:👍 abcd1234]")).toBe("Hello");
  });

  it("removes leading and trailing attachment tags but keeps middle filenames", () => {
    const text = "[ATTACH:/tmp/start.txt]\n\nSee [ATTACH:/tmp/middle.txt]\n\n[ATTACH:/tmp/end.txt]";
    expect(stripAttachmentTags(text)).toBe("See middle.txt");
  });
});
