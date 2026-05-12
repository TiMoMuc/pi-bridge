import { describe, expect, it } from "vitest";
import { markdownToSignal, serializeStyle, type SignalTextStyle } from "../src/format.js";

function styleAt(styles: SignalTextStyle[], style: SignalTextStyle["style"]): SignalTextStyle {
  const found = styles.find((entry) => entry.style === style);
  if (!found) throw new Error(`missing style ${style}`);
  return found;
}

describe("markdownToSignal", () => {
  it("keeps plain text unchanged", () => {
    expect(markdownToSignal("hello")).toEqual({ text: "hello", textStyles: [] });
  });

  it("formats double-asterisk bold", () => {
    const result = markdownToSignal("Hello **world**");
    expect(result.text).toBe("Hello world");
    expect(result.textStyles).toEqual([{ start: 6, length: 5, style: "BOLD" }]);
  });

  it("formats single-asterisk bold", () => {
    const result = markdownToSignal("*bold*");
    expect(result.text).toBe("bold");
    expect(result.textStyles).toEqual([{ start: 0, length: 4, style: "BOLD" }]);
  });

  it("formats double-underscore italic", () => {
    const result = markdownToSignal("__italics__");
    expect(result.text).toBe("italics");
    expect(result.textStyles).toEqual([{ start: 0, length: 7, style: "ITALIC" }]);
  });

  it("formats single-underscore italic", () => {
    const result = markdownToSignal("_italics_");
    expect(result.text).toBe("italics");
    expect(result.textStyles).toEqual([{ start: 0, length: 7, style: "ITALIC" }]);
  });

  it("formats strikethrough", () => {
    const result = markdownToSignal("~~obsolete~~");
    expect(result.text).toBe("obsolete");
    expect(result.textStyles).toEqual([{ start: 0, length: 8, style: "STRIKETHROUGH" }]);
  });

  it("formats inline code", () => {
    const result = markdownToSignal("Use `rg` here");
    expect(result.text).toBe("Use rg here");
    expect(result.textStyles).toEqual([{ start: 4, length: 2, style: "MONOSPACE" }]);
  });

  it("formats fenced code blocks", () => {
    const result = markdownToSignal("```ts\nconst x = 1;\nconsole.log(x);\n```");
    expect(result.text).toBe("const x = 1;\nconsole.log(x);");
    expect(result.textStyles).toEqual([{ start: 0, length: result.text.length, style: "MONOSPACE" }]);
  });

  it("formats headings as bold lines", () => {
    const result = markdownToSignal("# Heading");
    expect(result.text).toBe("Heading");
    expect(result.textStyles).toEqual([{ start: 0, length: 7, style: "BOLD" }]);
  });

  it("converts list markers to bullets", () => {
    const result = markdownToSignal("- first\n* second");
    expect(result.text).toBe("• first\n• second");
    expect(result.textStyles).toEqual([]);
  });

  it("expands markdown links to label and url", () => {
    const result = markdownToSignal("See [Docs](https://example.com/docs)");
    expect(result.text).toBe("See Docs (https://example.com/docs)");
  });

  it("keeps markdown links compact when label equals url", () => {
    const result = markdownToSignal("[https://example.com](https://example.com)");
    expect(result.text).toBe("https://example.com");
  });

  it("tracks UTF-16 offsets correctly", () => {
    const result = markdownToSignal("😀 **ok**");
    expect(result.text).toBe("😀 ok");
    expect(result.textStyles).toEqual([{ start: 3, length: 2, style: "BOLD" }]);
  });

  it("handles repeated substrings without indexOf bugs", () => {
    const result = markdownToSignal("**same** and **same**");
    expect(result.text).toBe("same and same");
    expect(result.textStyles).toEqual([
      { start: 0, length: 4, style: "BOLD" },
      { start: 9, length: 4, style: "BOLD" },
    ]);
  });

  it("supports nested styles by preserving inner ranges", () => {
    const result = markdownToSignal("**mix _it_**");
    expect(result.text).toBe("mix it");
    expect(result.textStyles).toEqual([
      { start: 0, length: 6, style: "BOLD" },
      { start: 4, length: 2, style: "ITALIC" },
    ]);
  });

  it("serializes styles for signal-cli", () => {
    expect(serializeStyle({ start: 1, length: 4, style: "BOLD" })).toBe("1:4:BOLD");
  });

  it("supports mixed formatting in one message", () => {
    const result = markdownToSignal("# Title\n- **Bold** _italic_ `code` ~~gone~~");
    expect(result.text).toBe("Title\n• Bold italic code gone");
    expect(styleAt(result.textStyles, "BOLD")).toEqual({ start: 0, length: 5, style: "BOLD" });
    expect(result.textStyles).toContainEqual({ start: 8, length: 4, style: "BOLD" });
    expect(result.textStyles).toContainEqual({ start: 13, length: 6, style: "ITALIC" });
    expect(result.textStyles).toContainEqual({ start: 20, length: 4, style: "MONOSPACE" });
    expect(result.textStyles).toContainEqual({ start: 25, length: 4, style: "STRIKETHROUGH" });
  });
});
