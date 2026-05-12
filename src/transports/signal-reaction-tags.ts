import {
  parseReactionTags as parseOutboundReactionTags,
  stripReactionTags as stripOutboundReactionTags,
  type ParsedReactionTag,
} from "../outbound-control.js";

export type { ParsedReactionTag };

export function parseReactionTags(text: string): ParsedReactionTag[] {
  return parseOutboundReactionTags(text);
}

export function stripReactionTags(text: string): string {
  return stripOutboundReactionTags(text);
}
