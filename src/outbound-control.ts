import * as path from "node:path";

export interface ParsedReactionTag {
  emoji: string;
  sessionMessageId: string;
}

export interface ParsedOutboundControl {
  rawText: string;
  silent: boolean;
  visibleText: string;
  reactions: ParsedReactionTag[];
  attachmentPaths: string[];
}

export interface OutboundControlOptions {
  waitCalled?: boolean;
}

const REACTION_TAG_REGEX = /\[REACT:\s*(\S+)\s+([a-f0-9]{8})\s*\]/gi;
const ATTACH_TAG_REGEX = /\[ATTACH:\s*([^\]]+?)\s*\]/g;

export function parseOutboundControl(
  text: string,
  options: OutboundControlOptions = {},
): ParsedOutboundControl {
  const rawText = text;

  if (options.waitCalled) {
    return {
      rawText,
      silent: true,
      visibleText: "",
      reactions: [],
      attachmentPaths: [],
    };
  }

  const reactions = parseReactionTags(text);
  const attachmentPaths = parseAttachmentPaths(text);
  const withoutReactions = stripReactionTags(text);
  const visibleText = stripAttachmentTags(withoutReactions);

  return {
    rawText,
    silent: false,
    visibleText,
    reactions,
    attachmentPaths,
  };
}

export function parseReactionTags(text: string): ParsedReactionTag[] {
  const seen = new Set<string>();
  const result: ParsedReactionTag[] = [];

  for (const match of text.matchAll(REACTION_TAG_REGEX)) {
    const emoji = match[1]?.trim();
    const sessionMessageId = match[2]?.trim();
    if (!emoji || !sessionMessageId) continue;
    const key = `${emoji}:${sessionMessageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ emoji, sessionMessageId });
  }

  return result;
}

export function stripReactionTags(text: string): string {
  return text
    .replace(REACTION_TAG_REGEX, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseAttachmentPaths(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const match of text.matchAll(ATTACH_TAG_REGEX)) {
    const filePath = match[1]?.trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    result.push(filePath);
  }

  return result;
}

export function stripAttachmentTags(text: string): string {
  const tags: Array<{ start: number; end: number; filePath: string }> = [];
  for (const match of text.matchAll(ATTACH_TAG_REGEX)) {
    const start = match.index;
    tags.push({
      start,
      end: start + match[0].length,
      filePath: match[1].trim(),
    });
  }

  if (tags.length === 0) return text.trim();

  const trimmedStart = text.search(/\S/);
  const trimmedEnd = text.search(/\S\s*$/) + 1;

  let result = "";
  let cursor = 0;

  for (const tag of tags) {
    result += text.slice(cursor, tag.start);

    const isAtStart = text.slice(trimmedStart, tag.end).replace(/\s/g, "") ===
      text.slice(tag.start, tag.end).replace(/\s/g, "");
    const isAtEnd = text.slice(tag.start, trimmedEnd).replace(/\s/g, "") ===
      text.slice(tag.start, tag.end).replace(/\s/g, "");

    if (!isAtStart && !isAtEnd) {
      result += path.basename(tag.filePath);
    }

    cursor = tag.end;
  }

  result += text.slice(cursor);
  return result.replace(/\n{3,}/g, "\n\n").trim();
}
