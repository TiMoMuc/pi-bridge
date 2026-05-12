import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const tempDirs = new Set<string>();

async function createTempWorkspace(prefix: string): Promise<{ root: string; cwd: string; sessionDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(root);
  const cwd = path.join(root, "work");
  const sessionDir = path.join(root, "sessions");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  return { root, cwd, sessionDir };
}

function createMinimalResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are a test assistant.",
    getAppendSystemPrompt: () => ["Be concise."],
    extendResources: () => {},
    reload: async () => {},
  };
}

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      tempDirs.delete(dir);
    }),
  );
});

describe("SDK smoke tests", () => {
  it("ModelRegistry finds built-in Anthropic models", () => {
    const auth = AuthStorage.create();
    const registry = ModelRegistry.inMemory(auth);

    const model = registry.find("anthropic", "claude-sonnet-4-5");

    expect(model).toBeDefined();
    expect(model?.id).toBe("claude-sonnet-4-5");
    expect(model?.provider).toBe("anthropic");
  });

  it("Single AuthStorage/ModelRegistry pair is consistent across lookups", async () => {
    const auth = AuthStorage.create();
    auth.setRuntimeApiKey("anthropic", "test-key");
    const registry = ModelRegistry.inMemory(auth);

    const first = registry.find("anthropic", "claude-sonnet-4-5");
    const second = registry.find("anthropic", "claude-sonnet-4-5");
    const apiKey = await auth.getApiKey("anthropic");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(apiKey).toBe("test-key");
  });

  it("createAgentSession accepts the ResourceLoader shape we use", async () => {
    const { cwd, sessionDir } = await createTempWorkspace("sdk-smoke-");
    const auth = AuthStorage.create();
    auth.setRuntimeApiKey("anthropic", "test-key");
    const registry = ModelRegistry.inMemory(auth);
    const model = registry.find("anthropic", "claude-sonnet-4-5");

    expect(model).toBeDefined();

    const sessionManager = SessionManager.create(cwd, sessionDir);
    const result = await createAgentSession({
      cwd,
      model,
      thinkingLevel: "off",
      authStorage: auth,
      modelRegistry: registry,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 1 },
      }),
      resourceLoader: createMinimalResourceLoader(),
    });

    expect(typeof result.session.prompt).toBe("function");
    expect(typeof result.session.subscribe).toBe("function");
  });

  it("AuthStorage runtime API key round-trips correctly", async () => {
    const auth = AuthStorage.create();
    auth.setRuntimeApiKey("anthropic", "sk-test-123");

    const apiKey = await auth.getApiKey("anthropic");

    expect(apiKey).toBe("sk-test-123");
  });

  it("ModelRegistry.find() returns undefined for unknown models", () => {
    const auth = AuthStorage.create();
    const registry = ModelRegistry.inMemory(auth);

    const model = registry.find("nonexistent-provider", "nonexistent-model");

    expect(model).toBeUndefined();
  });
});
