/**
 * Splits a long string into Signal-friendly chunks.
 *
 * Signal supports up to ~60 000 chars per message, but shorter chunks
 * produce more readable chat bubbles. Default max is 4 000 chars.
 *
 * Split priority: paragraph break → line break → sentence end → hard cut.
 * The cut point must be in the second half of the chunk to avoid tiny fragments.
 */

import type { SignalTextStyle } from "./format.js";

export const MAX_MESSAGE_LENGTH = 4_000;

export interface StyledChunk {
  text: string;
  textStyles: SignalTextStyle[];
}

export function splitMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  return splitIntoChunks(text, maxLen).map((chunk) => chunk.text);
}

export function splitForSignal(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  return splitMessage(text, maxLen);
}

export function splitWithStyles(
  text: string,
  styles: SignalTextStyle[],
  maxLen = MAX_MESSAGE_LENGTH,
): StyledChunk[] {
  return splitIntoChunks(text, maxLen).map((chunk) => ({
    text: chunk.text,
    textStyles: styles
      .map((style) => clampStyleToChunk(style, chunk.start, chunk.end))
      .filter((style): style is SignalTextStyle => style !== null),
  }));
}

interface ChunkRange {
  text: string;
  start: number;
  end: number;
}

function splitIntoChunks(text: string, maxLen: number): ChunkRange[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) {
    return [{ text: trimmed, start: 0, end: trimmed.length }];
  }

  const parts: ChunkRange[] = [];
  let remaining = trimmed;
  let cursor = 0;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push({ text: remaining, start: cursor, end: cursor + remaining.length });
      break;
    }

    const half = maxLen * 0.5;
    let cutAt = -1;

    const para = remaining.lastIndexOf("\n\n", maxLen);
    if (para > half) cutAt = para;

    if (cutAt === -1) {
      const line = remaining.lastIndexOf("\n", maxLen);
      if (line > half) cutAt = line;
    }

    if (cutAt === -1) {
      const sentence = remaining.lastIndexOf(". ", maxLen);
      if (sentence > half) cutAt = sentence + 1;
    }

    if (cutAt === -1) cutAt = maxLen;

    const rawChunk = remaining.slice(0, cutAt);
    const chunkText = rawChunk.trimEnd();
    const chunkStart = cursor;
    const chunkEnd = cursor + chunkText.length;
    parts.push({ text: chunkText, start: chunkStart, end: chunkEnd });

    const restRaw = remaining.slice(cutAt);
    const trimmedLeading = restRaw.length - restRaw.trimStart().length;
    remaining = restRaw.trimStart();
    cursor += cutAt + trimmedLeading;
  }

  return parts.filter((part) => part.text.length > 0 || part.start === 0);
}

function clampStyleToChunk(
  style: SignalTextStyle,
  chunkStart: number,
  chunkEnd: number,
): SignalTextStyle | null {
  const styleEnd = style.start + style.length;
  const overlapStart = Math.max(style.start, chunkStart);
  const overlapEnd = Math.min(styleEnd, chunkEnd);
  if (overlapEnd <= overlapStart) return null;

  return {
    start: overlapStart - chunkStart,
    length: overlapEnd - overlapStart,
    style: style.style,
  };
}
