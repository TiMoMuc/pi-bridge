import { describe, it, expect } from "vitest";
import { splitForSignal, splitWithStyles, MAX_MESSAGE_LENGTH } from "../src/split.js";

describe("splitForSignal", () => {
  it("returns the text unchanged when it fits in one chunk", () => {
    expect(splitForSignal("hello")).toEqual(["hello"]);
  });

  it("returns one chunk for text at exactly maxLen", () => {
    const text = "a".repeat(MAX_MESSAGE_LENGTH);
    expect(splitForSignal(text)).toEqual([text]);
  });

  it("splits at paragraph break", () => {
    const a = "a".repeat(3_000);
    const b = "b".repeat(3_000);
    const parts = splitForSignal(`${a}\n\n${b}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(a);
    expect(parts[1]).toBe(b);
  });

  it("splits at line break when no paragraph break is available", () => {
    const a = "a".repeat(3_000);
    const b = "b".repeat(3_000);
    const parts = splitForSignal(`${a}\n${b}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(a);
    expect(parts[1]).toBe(b);
  });

  it("hard-cuts when no good break point exists", () => {
    const text = "a".repeat(5_000);
    const parts = splitForSignal(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it("produces no empty parts", () => {
    const text = "x".repeat(9_000);
    const parts = splitForSignal(text);
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
    }
  });

  it("reassembles to original text (ignoring split whitespace)", () => {
    const text = "word ".repeat(2_000).trim();
    const parts = splitForSignal(text);
    expect(parts.join(" ").replace(/\s+/g, " ").trim().length).toBeGreaterThan(text.length * 0.99);
  });

  it("respects a custom maxLen", () => {
    const parts = splitForSignal("hello world foo bar", 10);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(10);
    }
  });

  it("trims leading and trailing whitespace from input", () => {
    const parts = splitForSignal("  hello  ");
    expect(parts).toEqual(["hello"]);
  });
});

describe("splitWithStyles", () => {
  it("returns one styled chunk when text fits", () => {
    const parts = splitWithStyles("hello", [{ start: 0, length: 5, style: "BOLD" }], 10);
    expect(parts).toEqual([{ text: "hello", textStyles: [{ start: 0, length: 5, style: "BOLD" }] }]);
  });

  it("re-bases style offsets per chunk", () => {
    const text = `Hello\n${"a".repeat(8)}\n${"b".repeat(8)}`;
    const parts = splitWithStyles(text, [{ start: 6, length: 8, style: "ITALIC" }], 14);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      text: `Hello\n${"a".repeat(8)}`,
      textStyles: [{ start: 6, length: 8, style: "ITALIC" }],
    });
    expect(parts[1].textStyles).toEqual([]);
  });

  it("clamps a style that crosses a chunk boundary", () => {
    const parts = splitWithStyles("abcdefghij", [{ start: 3, length: 5, style: "BOLD" }], 5);
    expect(parts).toEqual([
      { text: "abcde", textStyles: [{ start: 3, length: 2, style: "BOLD" }] },
      { text: "fghij", textStyles: [{ start: 0, length: 3, style: "BOLD" }] },
    ]);
  });

  it("drops non-overlapping styles from a chunk", () => {
    const parts = splitWithStyles("abcdefghij", [{ start: 8, length: 2, style: "MONOSPACE" }], 5);
    expect(parts[0].textStyles).toEqual([]);
    expect(parts[1].textStyles).toEqual([{ start: 3, length: 2, style: "MONOSPACE" }]);
  });

  it("supports empty text for attachment-only messages", () => {
    expect(splitWithStyles("", [], 10)).toEqual([{ text: "", textStyles: [] }]);
  });
});
