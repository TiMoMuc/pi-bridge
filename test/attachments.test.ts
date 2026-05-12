import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  saveAttachment,
  processAttachments,
  parseOutboundPaths,
  stripAttachmentTags,
  modelSupportsVision,
  toAgentPath,
  toBridgePath,
} from "../src/attachments.js";
import type { Transport, TransportAttachment } from "../src/transport.js";

type SignalLikeAttachment = TransportAttachment & {
  data?: string;
  storedFilename?: string;
};
type SignalAttachment = SignalLikeAttachment;
type SignalClient = Pick<Transport, "fetchAttachment">;

// Mock transport attachment fetch for testing
function mockSignalClient(fetchAttachmentResponse?: string): {
  client: SignalClient;
  getAttachmentMock: Mock;
} {
  const getAttachmentMock = vi.fn(async (attachment: TransportAttachment, _sender: string) => {
    const signalLike = attachment as SignalLikeAttachment;
    if (signalLike.data) {
      return Buffer.from(signalLike.data, "base64");
    }
    if (signalLike.storedFilename) {
      return fs.readFile(signalLike.storedFilename);
    }
    if (!fetchAttachmentResponse) {
      throw new Error("fetch failed");
    }
    return Buffer.from(fetchAttachmentResponse, "base64");
  });
  return { client: { fetchAttachment: getAttachmentMock }, getAttachmentMock };
}

describe("saveAttachment", () => {
  let tmpDir: string;
  let userDir: string;
  const sender = "+1234";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachments-test-"));
    userDir = path.join(tmpDir, "users", "+1234");
    await fs.mkdir(userDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("saves inline base64 attachment", async () => {
    const attachment: SignalAttachment = {
      id: "abc123def456",
      contentType: "image/jpeg",
      filename: "photo.jpg",
      data: Buffer.from("fake image data").toString("base64"),
    };
    const { client, getAttachmentMock } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("image/jpeg");
    expect(result!.localPath).toContain("upload");
    expect(result!.localPath).toContain(".jpg");

    const content = await fs.readFile(result!.localPath, "utf8");
    expect(content).toBe("fake image data");
    expect(getAttachmentMock).toHaveBeenCalledWith(attachment, sender);
  });

  it("saves attachment with storedFilename", async () => {
    // Create a source file
    const sourceFile = path.join(tmpDir, "source.pdf");
    await fs.writeFile(sourceFile, "PDF content");

    const attachment: SignalAttachment = {
      id: "xyz789",
      contentType: "application/pdf",
      storedFilename: sourceFile,
    };
    const { client, getAttachmentMock } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("application/pdf");
    const content = await fs.readFile(result!.localPath, "utf8");
    expect(content).toBe("PDF content");
    expect(getAttachmentMock).toHaveBeenCalledWith(attachment, sender);
  });

  it("fetches attachment via getAttachment RPC when no inline data", async () => {
    const attachment: SignalAttachment = {
      id: "fetch123",
      contentType: "image/png",
    };
    const base64Data = Buffer.from("fetched image data").toString("base64");
    const { client, getAttachmentMock } = mockSignalClient(base64Data);

    const result = await saveAttachment(attachment, userDir, client, sender);

    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("image/png");
    expect(getAttachmentMock).toHaveBeenCalledWith(attachment, sender);

    const content = await fs.readFile(result!.localPath, "utf8");
    expect(content).toBe("fetched image data");
  });

  it("saves to flat upload directory with date prefix", async () => {
    const attachment: SignalAttachment = {
      id: "test123",
      contentType: "text/plain",
      filename: "notes.txt",
      data: Buffer.from("hello").toString("base64"),
    };
    const { client } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    // Flat in upload/, not in upload/YYYY-MM-DD/
    expect(result!.localPath).toMatch(/upload\/\d{4}-\d{2}-\d{2}_/);
    expect(result!.localPath).not.toMatch(/upload\/\d{4}-\d{2}-\d{2}\//);
  });

  it("strips existing extension to avoid double extensions", async () => {
    const attachment: SignalAttachment = {
      id: "abc123def456",
      contentType: "image/jpeg",
      filename: "image.jpeg", // Has .jpeg — should keep .jpeg (original), not replace with .jpg (MIME)
      data: Buffer.from("fake jpeg").toString("base64"),
    };
    const { client } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    // Should preserve original .jpeg extension, not double up
    expect(result!.localPath).toMatch(/image-[a-z0-9]+\.jpeg$/);
    expect(result!.localPath).not.toContain(".jpeg.jpg");
    expect(result!.localPath).not.toContain(".jpeg.jpeg");
  });

  it("strips extension from signal-cli ID (PNG, no filename)", async () => {
    // signal-cli appends the mime extension to the ID itself:
    // e.g. "TY0W2d0JOidFB_eE5B0i.png"
    const attachment: SignalAttachment = {
      id: "TY0W2d0JOidFB_eE5B0i.png",
      contentType: "image/png",
      filename: null as unknown as string,
      data: Buffer.from("fake png").toString("base64"),
    };
    const { client } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    // Constructed from id.slice(0,8) + clean suffix — must NOT end in .png.png
    expect(result!.localPath).toMatch(/\.png$/);
    expect(result!.localPath).not.toMatch(/\.png\.png$/);
  });

  it("strips extension from signal-cli ID (PDF, with user filename)", async () => {
    // Real observed event: id ends in ".pdf", filename is user's original name
    const attachment: SignalAttachment = {
      id: "WzeTWi9KypMaxX-eAJhA.pdf",
      contentType: "application/pdf",
      filename: "report.pdf",
      data: Buffer.from("fake pdf").toString("base64"),
    };
    const { client } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    // baseName = "report", idSuffix from cleanId (no dash-start) → "report-<suffix>.pdf"
    expect(result!.localPath).toMatch(/report-[a-zA-Z0-9]+\.pdf$/);
    expect(result!.localPath).not.toMatch(/\.pdf\.pdf$/);
  });

  it("handles audio/x-m4a mime type (Signal's variant for m4a files)", async () => {
    // Signal sends "audio/x-m4a" not "audio/mp4" — must map to .m4a extension
    const attachment: SignalAttachment = {
      id: "oks0ofKkWa8PquyVEo0q.m4a",
      contentType: "audio/x-m4a",
      filename: "test.m4a",
      data: Buffer.from("fake audio").toString("base64"),
    };
    const { client } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    expect(result!.localPath).toMatch(/test-[a-zA-Z0-9]+\.m4a$/);
    expect(result!.localPath).not.toMatch(/\.m4a\.m4a$/);
  });

  it("preserves .md extension (not in MIME map)", async () => {
    const attachment: SignalAttachment = {
      id: "abcdefghijklmnopqrst",
      contentType: "text/markdown",
      filename: "projekt-status-dialektisch.md",
      data: Buffer.from("# Hello").toString("base64"),
    };
    const { client } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    expect(result!.localPath).toMatch(/projekt-status-dialektisch-[a-zA-Z0-9]+\.md$/);
    expect(result!.localPath).not.toMatch(/-[a-zA-Z0-9]+$/); // must have extension
  });

  it("preserves .docx extension (not in MIME map)", async () => {
    const attachment: SignalAttachment = {
      id: "XYZ123abcdefghijklmn.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "report final (v2).docx",
      data: Buffer.from("fake docx").toString("base64"),
    };
    const { client } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    expect(result!.localPath).toMatch(/report final \(v2\)-[a-zA-Z0-9]+\.docx$/);
  });

  it("preserves .py extension with text/x-python MIME", async () => {
    const attachment: SignalAttachment = {
      id: "pyfile12345678901234",
      contentType: "text/x-python",
      filename: "script.py",
      data: Buffer.from("print('hi')").toString("base64"),
    };
    const { client } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    expect(result!.localPath).toMatch(/script-[a-zA-Z0-9]+\.py$/);
  });

  it("handles filename with no extension and unknown MIME", async () => {
    const attachment: SignalAttachment = {
      id: "eGJyhkpwgm9z_0wbOcBW",
      contentType: "",
      filename: "withoutfileextension",
      data: Buffer.from("raw data").toString("base64"),
    };
    const { client } = mockSignalClient();

    const result = await saveAttachment(attachment, userDir, client, sender);

    // No extension at all — correct behavior
    expect(result!.localPath).toMatch(/withoutfileextension-[a-zA-Z0-9]+$/);
    expect(result!.localPath).not.toContain(".");
  });

  it("returns null when getAttachment fails", async () => {
    const attachment: SignalAttachment = {
      id: "empty",
      contentType: "image/png",
    };
    const { client } = mockSignalClient(undefined);

    const result = await saveAttachment(attachment, userDir, client, sender);
    expect(result).toBeNull();
  });
});

describe("processAttachments", () => {
  let tmpDir: string;
  let userDir: string;
  const sender = "+1234";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "process-test-"));
    userDir = path.join(tmpDir, "users", "+1234");
    await fs.mkdir(userDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("processes image with vision support", async () => {
    const attachments: SignalAttachment[] = [
      {
        id: "img123",
        contentType: "image/jpeg",
        filename: "test.jpg",
        data: Buffer.from("fake jpeg").toString("base64"),
      },
    ];
    const { client } = mockSignalClient();

    const result = await processAttachments(attachments, userDir, true, client, sender);

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].kind).toBe("image");
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/jpeg");
    expect(result.preamble).toBe(""); // No preamble for native images
  });

  it("processes image without vision support", async () => {
    const attachments: SignalAttachment[] = [
      {
        id: "img123",
        contentType: "image/jpeg",
        data: Buffer.from("fake jpeg").toString("base64"),
      },
    ];
    const { client } = mockSignalClient();

    const result = await processAttachments(attachments, userDir, false, client, sender);

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].kind).toBe("file");
    expect(result.images).toHaveLength(0);
    expect(result.preamble).toContain("[Attachment 1/1: image/jpeg]");
    expect(result.preamble).toContain("File saved:");
  });

  it("adds hints for audio files", async () => {
    const attachments: SignalAttachment[] = [
      {
        id: "audio123",
        contentType: "audio/aac",
        data: Buffer.from("fake audio").toString("base64"),
      },
    ];
    const { client } = mockSignalClient();

    const result = await processAttachments(attachments, userDir, false, client, sender);

    expect(result.preamble).toContain("process this audio file");
  });

  it("adds hints for PDF files", async () => {
    const attachments: SignalAttachment[] = [
      {
        id: "pdf123",
        contentType: "application/pdf",
        data: Buffer.from("fake pdf").toString("base64"),
      },
    ];
    const { client } = mockSignalClient();

    const result = await processAttachments(attachments, userDir, false, client, sender);

    expect(result.preamble).toContain("inspect this PDF");
  });

  it("handles multiple attachments", async () => {
    const attachments: SignalAttachment[] = [
      { id: "a1", contentType: "image/png", data: Buffer.from("img1").toString("base64") },
      { id: "a2", contentType: "text/plain", data: Buffer.from("text").toString("base64") },
    ];
    const { client } = mockSignalClient();

    const result = await processAttachments(attachments, userDir, false, client, sender);

    expect(result.processed).toHaveLength(2);
    expect(result.preamble).toContain("[Attachment 1/2:");
    expect(result.preamble).toContain("[Attachment 2/2:");
  });
});

describe("parseOutboundPaths", () => {
  let tmpDir: string;
  let userDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-test-"));
    userDir = path.join(tmpDir, "workspace", "users", "+1234");
    await fs.mkdir(path.join(userDir, "work"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts path from [ATTACH:path] tag", async () => {
    const filePath = path.join(userDir, "work", "report.pdf");
    await fs.writeFile(filePath, "content");

    const text = `Here's your report: [ATTACH:${filePath}]`;
    const result = await parseOutboundPaths(text, userDir);

    expect(result.validPaths).toHaveLength(1);
    expect(result.validPaths[0]).toBe(filePath);
  });

  it("extracts multiple [ATTACH:] tags", async () => {
    const file1 = path.join(userDir, "work", "a.pdf");
    const file2 = path.join(userDir, "work", "b.txt");
    await fs.writeFile(file1, "a");
    await fs.writeFile(file2, "b");

    const text = `Files: [ATTACH:${file1}] and [ATTACH:${file2}]`;
    const result = await parseOutboundPaths(text, userDir);

    expect(result.validPaths).toHaveLength(2);
    expect(result.validPaths).toContain(file1);
    expect(result.validPaths).toContain(file2);
  });

  it("handles whitespace inside [ATTACH:] tag", async () => {
    const filePath = path.join(userDir, "work", "report.pdf");
    await fs.writeFile(filePath, "content");

    const text = `[ATTACH:  ${filePath}  ]`;
    const result = await parseOutboundPaths(text, userDir);

    expect(result.validPaths).toHaveLength(1);
    expect(result.validPaths[0]).toBe(filePath);
  });

  it("rejects paths outside user workspace", async () => {
    const text = `[ATTACH:/workspace/users/+9999/secret.txt]`;
    const result = await parseOutboundPaths(text, userDir);

    expect(result.validPaths).toHaveLength(0);
    expect(result.invalidPaths).toHaveLength(1);
    expect(result.invalidPaths[0].reason).toBe("outside user workspace");
  });

  it("rejects non-existent files", async () => {
    const text = `[ATTACH:${path.join(userDir, "work", "missing.pdf")}]`;
    const result = await parseOutboundPaths(text, userDir);

    expect(result.validPaths).toHaveLength(0);
    expect(result.invalidPaths).toHaveLength(1);
    expect(result.invalidPaths[0].reason).toBe("file not found");
  });

  it("deduplicates repeated [ATTACH:] tags", async () => {
    const filePath = path.join(userDir, "work", "report.pdf");
    await fs.writeFile(filePath, "content");

    const text = `[ATTACH:${filePath}] and again [ATTACH:${filePath}]`;
    const result = await parseOutboundPaths(text, userDir);

    expect(result.validPaths).toHaveLength(1);
  });

  it("returns empty for bare paths without [ATTACH:] tag", async () => {
    const filePath = path.join(userDir, "work", "report.pdf");
    await fs.writeFile(filePath, "content");

    const text = `Here's your report: ${filePath}`;
    const result = await parseOutboundPaths(text, userDir);

    expect(result.validPaths).toHaveLength(0);
    expect(result.invalidPaths).toHaveLength(0);
  });

  it("returns empty for no [ATTACH:] tags", async () => {
    const result = await parseOutboundPaths("Just a normal message.", userDir);
    expect(result.validPaths).toHaveLength(0);
    expect(result.invalidPaths).toHaveLength(0);
  });
});

describe("stripAttachmentTags", () => {
  it("removes [ATTACH:] tag at start of message", () => {
    const text = "[ATTACH:/workspace/users/+1234/work/file.pdf]\nHere is your file.";
    const result = stripAttachmentTags(text, ["/workspace/users/+1234/work/file.pdf"]);
    expect(result).toBe("Here is your file.");
  });

  it("removes [ATTACH:] tag at end of message", () => {
    const text = "Here is your file.\n[ATTACH:/workspace/users/+1234/work/file.pdf]";
    const result = stripAttachmentTags(text, ["/workspace/users/+1234/work/file.pdf"]);
    expect(result).toBe("Here is your file.");
  });

  it("replaces [ATTACH:] tag in middle with filename", () => {
    const text = "Here is your file [ATTACH:/workspace/users/+1234/work/skript.pdf] enjoy!";
    const result = stripAttachmentTags(text, ["/workspace/users/+1234/work/skript.pdf"]);
    expect(result).toBe("Here is your file skript.pdf enjoy!");
  });

  it("handles multiple tags — start, middle, end", () => {
    const text = "[ATTACH:/workspace/users/+1234/work/a.pdf]\nText with [ATTACH:/workspace/users/+1234/work/b.pdf] inside\n[ATTACH:/workspace/users/+1234/work/c.pdf]";
    const result = stripAttachmentTags(text, [
      "/workspace/users/+1234/work/a.pdf",
      "/workspace/users/+1234/work/b.pdf",
      "/workspace/users/+1234/work/c.pdf",
    ]);
    expect(result).toBe("Text with b.pdf inside");
  });

  it("collapses blank lines after stripping", () => {
    const text = "Hello.\n\n\n[ATTACH:/workspace/users/+1234/work/file.pdf]\n\n\nGoodbye.";
    const result = stripAttachmentTags(text, ["/workspace/users/+1234/work/file.pdf"]);
    expect(result).not.toMatch(/\n{3,}/);
  });

  it("returns text unchanged when no tags present", () => {
    const text = "Just a normal message.";
    const result = stripAttachmentTags(text, []);
    expect(result).toBe("Just a normal message.");
  });

  it("strips sole [ATTACH:] tag to empty after trim", () => {
    const text = "  [ATTACH:/workspace/users/+1234/work/file.pdf]  ";
    const result = stripAttachmentTags(text, ["/workspace/users/+1234/work/file.pdf"]);
    expect(result).toBe("");
  });
});

describe("toAgentPath / toBridgePath", () => {
  const userDir = "/workspace/users/+49123";
  const agentRoot = "/workspace";

  describe("toAgentPath", () => {
    it("translates bridge path to agent-namespace path", () => {
      expect(toAgentPath(`${userDir}/upload/file.png`, userDir, agentRoot))
        .toBe("/workspace/upload/file.png");
    });

    it("translates nested bridge path", () => {
      expect(toAgentPath(`${userDir}/work/subdir/report.pdf`, userDir, agentRoot))
        .toBe("/workspace/work/subdir/report.pdf");
    });

    it("returns the original bridge path when agentWorkspaceRoot === userDir", () => {
      const p = `${userDir}/upload/file.png`;
      expect(toAgentPath(p, userDir, userDir)).toBe(p);
    });

    it("returns path unchanged when it is outside userDir", () => {
      const outside = "/workspace/users/+99999/upload/file.png";
      expect(toAgentPath(outside, userDir, agentRoot)).toBe(outside);
    });

    it("handles exact userDir path", () => {
      expect(toAgentPath(userDir, userDir, agentRoot)).toBe("/workspace");
    });

    it("does not match path that merely starts with same prefix (no slash guard)", () => {
      // +49123extra is NOT inside +49123
      const impostor = "/workspace/users/+49123extra/upload/file.png";
      expect(toAgentPath(impostor, userDir, agentRoot)).toBe(impostor);
    });
  });

  describe("toBridgePath", () => {
    it("translates agent-namespace path to bridge path", () => {
      expect(toBridgePath("/workspace/upload/file.png", userDir, agentRoot))
        .toBe(`${userDir}/upload/file.png`);
    });

    it("translates nested agent path", () => {
      expect(toBridgePath("/workspace/work/subdir/report.pdf", userDir, agentRoot))
        .toBe(`${userDir}/work/subdir/report.pdf`);
    });

    it("returns the original agent path when agentWorkspaceRoot === userDir", () => {
      const p = `${userDir}/upload/file.png`;
      expect(toBridgePath(p, userDir, userDir)).toBe(p);
    });

    it("returns path unchanged when it is outside agentRoot", () => {
      const outside = "/tmp/evil/file.png";
      expect(toBridgePath(outside, userDir, agentRoot)).toBe(outside);
    });

    it("handles exact agentRoot path", () => {
      expect(toBridgePath("/workspace", userDir, agentRoot)).toBe(userDir);
    });

    it("round-trips: toBridgePath(toAgentPath(p)) === p", () => {
      const bridgePath = `${userDir}/upload/2026-03-20_test.png`;
      const agentPath = toAgentPath(bridgePath, userDir, agentRoot);
      expect(toBridgePath(agentPath, userDir, agentRoot)).toBe(bridgePath);
    });

    it("round-trips: toAgentPath(toBridgePath(p)) === p", () => {
      const agentPath = "/workspace/work/output.md";
      const bridgePath = toBridgePath(agentPath, userDir, agentRoot);
      expect(toAgentPath(bridgePath, userDir, agentRoot)).toBe(agentPath);
    });
  });
});

describe("parseOutboundPaths — sandbox path translation", () => {
  let tmpDir: string;
  let userDir: string;
  // agentRoot is simulated by tmpDir in these tests (see beforeEach comment)

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-outbound-test-"));
    // Simulate: userDir is the bridge-namespace path; agentRoot is "/workspace"
    // We can't literally use "/workspace" in unit tests because we need files to
    // exist on disk. So we simulate by using a real tmpDir as both anchors.
    //
    // In production:
    //   userDir    = /workspace/users/+49xxx   (bridge FS)
    //   agentRoot  = /workspace                (sandbox FS — different container)
    //   The two namespaces share the same underlying host directory.
    //
    // For tests we use a simulated mapping:
    //   userDir    = <tmp>/bridge/users/+1234
    //   agentRoot  = <tmp>/agent               (simulates /workspace inside sandbox)
    // Files are written to userDir (bridge path); translation maps them to agentRoot.
    userDir = path.join(tmpDir, "bridge", "users", "+1234");
    await fs.mkdir(path.join(userDir, "work"), { recursive: true });
    await fs.mkdir(path.join(userDir, "upload"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts agent-namespace path and returns bridge path", async () => {
    // File lives at bridge path
    const bridgeFile = path.join(userDir, "upload", "screenshot.png");
    await fs.writeFile(bridgeFile, "png-data");

    // Agent knows the file as an agent-namespace path
    const agentFile = toAgentPath(bridgeFile, userDir, tmpDir);
    const text = `Here is the screenshot [ATTACH:${agentFile}]`;

    const result = await parseOutboundPaths(text, userDir, tmpDir);

    expect(result.validPaths).toHaveLength(1);
    // Returned path must be the bridge path (what signal-cli needs)
    expect(result.validPaths[0]).toBe(bridgeFile);
    expect(result.invalidPaths).toHaveLength(0);
  });

  it("rejects path that is outside both agent namespace and user workspace", async () => {
    // A path completely outside agentRoot: toBridgePath returns it unchanged,
    // then the security check rejects it because it's not inside userDir.
    const text = `[ATTACH:/etc/passwd]`;
    const result = await parseOutboundPaths(text, userDir, tmpDir);
    expect(result.validPaths).toHaveLength(0);
    expect(result.invalidPaths[0].reason).toBe("outside user workspace");
  });

  it("still accepts a safe bridge-namespace path directly", async () => {
    const bridgeFile = path.join(userDir, "work", "report.md");
    await fs.writeFile(bridgeFile, "# Report");

    const text = `[ATTACH:${bridgeFile}]`;
    // agentWorkspaceRoot === userDir → no translation
    const result = await parseOutboundPaths(text, userDir, userDir);

    expect(result.validPaths).toHaveLength(1);
    expect(result.validPaths[0]).toBe(bridgeFile);
  });
});

describe("processAttachments — sandbox path translation in preamble", () => {
  let tmpDir: string;
  let userDir: string;
  const sender = "+1234";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-inbound-test-"));
    userDir = path.join(tmpDir, "users", "+1234");
    await fs.mkdir(userDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("shows agent-namespace path in preamble when agentWorkspaceRoot provided", async () => {
    const agentRoot = tmpDir; // simulates "/workspace" inside sandbox
    const attachments = [
      {
        id: "img001",
        contentType: "image/png",
        data: Buffer.from("fake png").toString("base64"),
      },
    ];
    const { client } = mockSignalClient();

    const result = await processAttachments(attachments, userDir, false, client, sender, agentRoot);

    // Preamble must contain the agent-namespace path, not the bridge path
    expect(result.preamble).toContain("File saved:");
    const savedLine = result.preamble.split("\n").find((l) => l.startsWith("File saved:"))!;
    const displayedPath = savedLine.replace("File saved: ", "");
    expect(displayedPath.startsWith(agentRoot)).toBe(true);
    expect(displayedPath).not.toContain("users/+1234");
  });

  it("shows bridge path in preamble when no agentWorkspaceRoot is provided", async () => {
    const attachments = [
      {
        id: "img002",
        contentType: "image/png",
        data: Buffer.from("fake png").toString("base64"),
      },
    ];
    const { client } = mockSignalClient();

    const result = await processAttachments(attachments, userDir, false, client, sender);

    const savedLine = result.preamble.split("\n").find((l) => l.startsWith("File saved:"))!;
    const displayedPath = savedLine.replace("File saved: ", "");
    expect(displayedPath.startsWith(userDir)).toBe(true);
  });
});

describe("modelSupportsVision", () => {
  it("detects Claude 3 models", () => {
    expect(modelSupportsVision("claude-3-opus-20240229")).toBe(true);
    expect(modelSupportsVision("claude-3-sonnet-20240229")).toBe(true);
    expect(modelSupportsVision("claude-3-haiku-20240307")).toBe(true);
  });

  it("detects Claude Sonnet 4", () => {
    expect(modelSupportsVision("claude-sonnet-4-5")).toBe(true);
  });

  it("detects GPT-4 vision models", () => {
    expect(modelSupportsVision("gpt-4o")).toBe(true);
    expect(modelSupportsVision("gpt-4o-mini")).toBe(true);
    expect(modelSupportsVision("gpt-4-turbo")).toBe(true);
  });

  it("detects Gemini models", () => {
    expect(modelSupportsVision("gemini-1.5-pro")).toBe(true);
    expect(modelSupportsVision("gemini-2.0-flash")).toBe(true);
  });

  it("returns false for text-only models", () => {
    expect(modelSupportsVision("gpt-3.5-turbo")).toBe(false);
    expect(modelSupportsVision("claude-2")).toBe(false);
  });
});
