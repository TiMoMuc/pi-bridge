import { markdownToSignal, serializeStyle } from "./format.js";
import { splitMessage, splitWithStyles } from "./split.js";
import type { Transport, TransportSendOptions } from "./transport.js";

export interface PreparedOutboundChunk {
  text: string;
  options: TransportSendOptions;
}

export function prepareOutboundChunks(
  transport: Transport,
  text: string,
  attachments: string[],
  target?: string,
): PreparedOutboundChunk[] {
  const chunks = transport.name === "signal"
    ? (() => {
      const formatted = markdownToSignal(text);
      return splitWithStyles(
        formatted.text,
        formatted.textStyles,
        transport.maxMessageLength,
      ).map((chunk, index) => ({
        text: chunk.text,
        options: {
          attachments: index === 0 && attachments.length > 0 ? attachments : undefined,
          textStyles: chunk.textStyles.map(serializeStyle),
          target,
        },
      }));
    })()
    : splitMessage(text, transport.maxMessageLength).map((chunkText, index) => ({
      text: chunkText,
      options: {
        attachments: index === 0 && attachments.length > 0 ? attachments : undefined,
        target,
      },
    }));

  return chunks.filter((chunk) => {
    const hasText = chunk.text.trim().length > 0;
    const hasAttachments = (chunk.options.attachments?.length ?? 0) > 0;
    return hasText || hasAttachments;
  });
}
