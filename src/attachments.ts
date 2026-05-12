/**
 * Attachment handling for inbound transport messages.
 *
 * Inbound: Save attachments to the workspace upload directory, build a preamble
 *          for the agent prompt, prepare images for native vision.
 *
 * Outbound: Parse file paths from agent responses, validate they exist and are
 *           within the user's workspace, return paths for transport attachment.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger } from "./logger.js";
import { parseAttachmentPaths, stripAttachmentTags as stripOutboundAttachmentTags } from "./outbound-control.js";
import type { Transport, TransportAttachment } from "./transport.js";

// ============================================================================
// Types
// ============================================================================

/** Attachment after saving to disk */
export interface SavedAttachment {
  localPath: string;
  contentType: string;
  filename?: string;
}

/** Processed attachment ready for agent consumption */
type ProcessedAttachment =
  | { kind: "image"; localPath: string; base64: string; mimeType: string }
  | { kind: "file"; localPath: string; contentType: string; filename?: string };

/** Result of processing all attachments in a message */
export interface AttachmentResult {
  /** All processed attachments */
  processed: ProcessedAttachment[];
  /** Text preamble to prepend to user message (for non-native attachments) */
  preamble: string;
  /** Images ready for native vision models */
  images: Array<{ data: string; mimeType: string }>;
}

/** Result of parsing outbound file paths */
export interface OutboundAttachment {
  /** Valid file paths that exist and are in user workspace */
  validPaths: string[];
  /** Paths that were found but don't exist or are outside workspace */
  invalidPaths: Array<{ path: string; reason: string }>;
}

// ============================================================================
// Inbound: Save and process attachments
// ============================================================================

/**
 * Save an inbound attachment to the workspace upload directory.
 * Files are saved flat in upload/ with a date prefix: YYYY-MM-DD_name-id.ext
 *
 * Filename construction priority:
 *   1. Original extension from attachment.filename (preserves .md, .py, .docx, etc.)
 *   2. MIME-derived extension (fallback for inline images with no filename)
 *   3. No extension (unknown MIME + no filename)
 *
 * Transport adapters provide attachment metadata on inbound messages and expose
 * `fetchAttachment()` to retrieve the binary content.
 *
 * @param attachment - Attachment metadata from the transport adapter
 * @param userDir - User's workspace directory
 * @param transport - Transport adapter for fetching attachment data
 * @param sender - Sender identity for the current conversation
 */
export async function saveAttachment(
  attachment: TransportAttachment,
  userDir: string,
  transport: Pick<Transport, "fetchAttachment">,
  sender: string,
): Promise<SavedAttachment | null> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const uploadsDir = path.join(userDir, "upload");
  await fs.mkdir(uploadsDir, { recursive: true });

  // --- Extension: prefer original filename's extension, fall back to MIME ---
  let ext: string;
  let baseName: string;

  if (attachment.filename) {
    const originalExt = path.extname(attachment.filename); // e.g. ".md", ".pdf", ".tar.gz" → ".gz"
    ext = originalExt || mimeToExtension(attachment.contentType);
    baseName = path.basename(attachment.filename, originalExt);
  } else {
    // No filename (e.g. inline/pasted images) — derive from MIME + use ID prefix
    ext = mimeToExtension(attachment.contentType);
    baseName = attachment.id.slice(0, 8);
  }

  // If baseName is empty after stripping, fall back to ID
  if (!baseName) {
    baseName = attachment.id.slice(0, 8);
  }

  // signal-cli appends the file extension to the attachment ID itself
  // (e.g. "TY0W2d0JOidFB_eE5B0i.png", "WzeTWi9KypMaxX-eAJhA.pdf").
  // Strip that extension before slicing so id.slice(-6) stays clean.
  const cleanId = attachment.id.replace(/(\.[a-zA-Z0-9]{1,5})+$/, "");
  // Also drop any leading non-alphanumeric character from the suffix (e.g. a "-")
  // so we never produce "basename--suffix.ext" when the id contains a dash near the end.
  const idSuffix = cleanId.slice(-6).replace(/^[^a-zA-Z0-9]/, "");

  const filename = `${today}_${baseName}-${idSuffix}${ext}`;
  const localPath = path.join(uploadsDir, filename);

  try {
    const buffer = await transport.fetchAttachment(attachment, sender);
    await fs.writeFile(localPath, buffer);
    getLogger().info("attachments", "saved", `Saved ${attachment.contentType} to ${localPath}`, {
      attachmentId: attachment.id,
      contentType: attachment.contentType,
      localPath,
      sender,
    });
    return { localPath, contentType: attachment.contentType, filename: attachment.filename };
  } catch (err) {
    getLogger().error("attachments", "save-failed", `Failed to save attachment ${attachment.id}`, {
      attachmentId: attachment.id,
      contentType: attachment.contentType,
      sender,
      error: err,
    });
    return null;
  }
}

/**
 * Process all attachments from a message.
 * Saves them to disk and prepares them for the agent.
 *
 * @param attachments - Raw attachments from the transport adapter
 * @param userDir - User's workspace directory (bridge namespace)
 * @param supportsVision - Whether the model supports native image input
 * @param transport - Transport adapter for fetching attachment data
 * @param sender - Sender identity for the current conversation
 * @param agentWorkspaceRoot - Agent's view of its workspace root. When provided,
 *   paths in the preamble are translated so the agent can find files at the paths
 *   it is told about.
 */
export async function processAttachments(
  attachments: TransportAttachment[],
  userDir: string,
  supportsVision: boolean,
  transport: Pick<Transport, "fetchAttachment">,
  sender: string,
  agentWorkspaceRoot?: string,
): Promise<AttachmentResult> {
  const processed: ProcessedAttachment[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  const preambleLines: string[] = [];

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const saved = await saveAttachment(attachment, userDir, transport, sender);

    if (!saved) {
      preambleLines.push(
        `[Attachment ${i + 1}/${attachments.length}: ${attachment.contentType}]`,
        `Error: Failed to save attachment`,
        "",
      );
      continue;
    }

    const isImage = saved.contentType.startsWith("image/");
    // Translate localPath to the agent's namespace for preamble display
    const displayPath = agentWorkspaceRoot
      ? toAgentPath(saved.localPath, userDir, agentWorkspaceRoot)
      : saved.localPath;

    if (isImage && supportsVision) {
      // Native vision: read file and encode as base64
      try {
        const data = await fs.readFile(saved.localPath);
        const base64 = data.toString("base64");
        processed.push({
          kind: "image",
          localPath: saved.localPath,
          base64,
          mimeType: saved.contentType,
        });
        images.push({ data: base64, mimeType: saved.contentType });
        // No preamble needed for native images
      } catch (err) {
        getLogger().error("attachments", "vision-read-failed", "Failed to read image for vision", {
          localPath: saved.localPath,
          error: err,
        });
        // Fall back to file notice
        processed.push({ kind: "file", localPath: saved.localPath, contentType: saved.contentType });
        preambleLines.push(...formatFilePreamble(i, attachments.length, saved, displayPath));
      }
    } else {
      // Non-image or no vision support: file path notice
      processed.push({
        kind: "file",
        localPath: saved.localPath,
        contentType: saved.contentType,
        filename: saved.filename,
      });
      preambleLines.push(...formatFilePreamble(i, attachments.length, saved, displayPath));
    }
  }

  const preamble = preambleLines.length > 0 ? preambleLines.join("\n") + "\n" : "";

  return { processed, preamble, images };
}

/** Format preamble lines for a file attachment */
function formatFilePreamble(
  index: number,
  total: number,
  saved: SavedAttachment,
  /** Path to show the agent — may be in agent namespace (sandbox) or bridge namespace */
  displayPath: string = saved.localPath,
): string[] {
  const typeLabel = saved.filename ? `${saved.contentType} — ${saved.filename}` : saved.contentType;
  const lines = [
    `[Attachment ${index + 1}/${total}: ${typeLabel}]`,
    `File saved: ${displayPath}`,
  ];

  // Add hints for common file types
  if (saved.contentType.startsWith("audio/")) {
    lines.push("(Use your tools to process this audio file)");
  } else if (saved.contentType === "application/pdf") {
    lines.push("(Use your tools to inspect this PDF if needed)");
  }

  lines.push("");
  return lines;
}

/** Map common MIME types to file extensions */
function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "audio/aac": ".aac",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/json": ".json",
  };
  return map[mimeType] ?? "";
}

// ============================================================================
// Sandbox path translation
// ============================================================================

/**
 * Translate a bridge-namespace path to the agent's view of its workspace.
 *
 * When the agent runs inside the workspace sandbox its user directory
 * is bind-mounted as `/workspace` inside the
 * container. Paths written by the bridge must be translated so the agent can
 * actually find the files.
 *
 * If `agentWorkspaceRoot === userDir`, the original bridge path is returned.
 *
 * @example
 * // sandboxed: userDir=/projects/example/Alice, agentRoot=/workspace
 * toAgentPath("/projects/example/Alice/upload/f.png", userDir, agentRoot)
 * // → "/workspace/upload/f.png"
 */
export function toAgentPath(
  bridgePath: string,
  userDir: string,
  agentWorkspaceRoot: string,
): string {
  if (agentWorkspaceRoot === userDir) return bridgePath;
  const normalizedUserDir = path.resolve(userDir);
  const normalized = path.resolve(bridgePath);
  // Must start with userDir/ (or equal userDir) to be translatable
  if (normalized !== normalizedUserDir && !normalized.startsWith(normalizedUserDir + "/")) {
    return bridgePath;
  }
  const relative = normalized.slice(normalizedUserDir.length); // e.g. "/upload/f.png"
  return agentWorkspaceRoot + relative;
}

/**
 * Translate an agent-namespace path back to the bridge's namespace.
 * Inverse of toAgentPath — used when parsing outbound [ATTACH:] tags.
 *
 * If `agentWorkspaceRoot === userDir`, the original agent path is returned.
 *
 * @example
 * // sandboxed: userDir=/projects/example/Alice, agentRoot=/workspace
 * toBridgePath("/workspace/upload/f.png", userDir, agentRoot)
 * // → "/projects/example/Alice/upload/f.png"
 */
export function toBridgePath(
  agentPath: string,
  userDir: string,
  agentWorkspaceRoot: string,
): string {
  if (agentWorkspaceRoot === userDir) return agentPath;
  const normalizedRoot = path.resolve(agentWorkspaceRoot);
  const normalized = path.resolve(agentPath);
  // Must start with agentRoot/ (or equal agentRoot) to be translatable
  if (normalized !== normalizedRoot && !normalized.startsWith(normalizedRoot + "/")) {
    return agentPath;
  }
  const relative = normalized.slice(normalizedRoot.length); // e.g. "/upload/f.png"
  return userDir + relative;
}

// ============================================================================
// Outbound: Validate parser-extracted [ATTACH:path] tags
// ============================================================================

/**
 * Validate parser-extracted attachment paths from an agent response.
 * Only returns paths that:
 * - Resolve to within the user's workspace directory (security check on bridge path)
 * - Actually exist on disk (checked via bridge path)
 *
 * When the agent runs in a Docker sandbox its workspace root differs from the
 * bridge's view. Pass `agentWorkspaceRoot` to enable transparent translation:
 *   agent path  `/workspace/upload/f.png`
 *   → bridge path `/projects/.../upload/f.png`
 *
 * Returned paths are always in bridge namespace so they can be handed directly
 * to the transport implementation.
 */
export async function resolveOutboundPaths(
  candidatePaths: string[],
  userDir: string,
  agentWorkspaceRoot?: string,
): Promise<OutboundAttachment> {
  const validPaths: string[] = [];
  const invalidPaths: Array<{ path: string; reason: string }> = [];

  const normalizedUserDir = path.resolve(userDir);
  const effectiveAgentRoot = agentWorkspaceRoot ?? userDir;

  for (const filePath of candidatePaths) {
    // Translate agent-namespace path → bridge-namespace path.
    const bridgePath = toBridgePath(filePath, userDir, effectiveAgentRoot);

    // Security: bridge path must be within user's workspace
    const normalizedBridge = path.resolve(bridgePath);
    if (!normalizedBridge.startsWith(normalizedUserDir)) {
      invalidPaths.push({ path: filePath, reason: "outside user workspace" });
      continue;
    }

    // Check if file exists at the bridge path
    try {
      const stat = await fs.stat(bridgePath);
      if (stat.isFile()) {
        validPaths.push(bridgePath); // bridge path — transport can resolve this
      } else {
        invalidPaths.push({ path: filePath, reason: "not a file" });
      }
    } catch {
      invalidPaths.push({ path: filePath, reason: "file not found" });
    }
  }

  return { validPaths, invalidPaths };
}

/**
 * Backwards-compatible helper that first parses `[ATTACH:...]` tags, then validates them.
 */
export async function parseOutboundPaths(
  text: string,
  userDir: string,
  agentWorkspaceRoot?: string,
): Promise<OutboundAttachment> {
  return resolveOutboundPaths(parseAttachmentPaths(text), userDir, agentWorkspaceRoot);
}

/**
 * Backwards-compatible helper that strips `[ATTACH:...]` tags from visible text.
 * The `validPaths` parameter is ignored; filenames are now derived directly from
 * the parsed tags in `src/outbound-control.ts`.
 */
export function stripAttachmentTags(text: string, _validPaths: string[] = []): string {
  return stripOutboundAttachmentTags(text);
}

// ============================================================================
// Vision support detection
// ============================================================================

/** Known vision-capable model patterns */
const VISION_MODEL_PATTERNS = [
  /claude-3/i,           // Claude 3 family (Opus, Sonnet, Haiku)
  /claude-sonnet-4/i,    // Claude Sonnet 4
  /gpt-4o/i,             // GPT-4o, GPT-4o-mini
  /gpt-4-turbo/i,        // GPT-4 Turbo with vision
  /gpt-4-vision/i,       // GPT-4 Vision
  /gemini/i,             // Gemini models
  /llava/i,              // LLaVA models
  /pixtral/i,            // Mistral Pixtral
];

/**
 * Check if a model supports vision based on its name.
 * This is a heuristic — if unsure, we'll try and let the API reject it.
 */
export function modelSupportsVision(modelName: string): boolean {
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(modelName));
}
