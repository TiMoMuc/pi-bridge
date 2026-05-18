import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const configSource = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const composeSource = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");

function extractRuntimeEnvKeysFromConfig(source: string): string[] {
  const keys = new Set<string>();

  for (const match of source.matchAll(/process\.env\["([A-Z0-9_]+)"\]/g)) {
    keys.add(match[1]);
  }

  for (const match of source.matchAll(/\bcsv\("([A-Z0-9_]+)"\)/g)) {
    keys.add(match[1]);
  }

  for (const match of source.matchAll(/\benv\("([A-Z0-9_]+)"(?:,\s*"([A-Z0-9_]+)")?\)/g)) {
    keys.add(match[1]);
  }

  for (const match of source.matchAll(/\bparseOptionalIdEnv\("([A-Z0-9_]+)"\)/g)) {
    keys.add(match[1]);
  }

  return [...keys].sort();
}

function extractBridgeComposeEnvKeys(source: string): string[] {
  const keys = new Set<string>();
  const lines = source.split(/\r?\n/);
  let inBridge = false;
  let inEnvironment = false;

  for (const line of lines) {
    if (!inBridge) {
      if (/^ {2}bridge:\s*$/.test(line)) {
        inBridge = true;
      }
      continue;
    }

    if (!inEnvironment) {
      if (/^ {4}environment:\s*$/.test(line)) {
        inEnvironment = true;
        continue;
      }
      if (/^ {2}[a-z0-9-]+:\s*$/i.test(line)) {
        inBridge = false;
      }
      continue;
    }

    const envMatch = line.match(/^ {6}([A-Z0-9_]+):/);
    if (envMatch) {
      keys.add(envMatch[1]);
      continue;
    }

    if (/^ {4}[a-z0-9-]+:\s*$/i.test(line) || /^ {2}[a-z0-9-]+:\s*$/i.test(line)) {
      break;
    }
  }

  return [...keys].sort();
}

function extractBridgeVolumeLines(source: string): string[] {
  const lines = source.split(/\r?\n/);
  let inBridge = false;
  let inVolumes = false;
  const volumes: string[] = [];

  for (const line of lines) {
    if (!inBridge) {
      if (/^ {2}bridge:\s*$/.test(line)) {
        inBridge = true;
      }
      continue;
    }

    if (!inVolumes) {
      if (/^ {4}volumes:\s*$/.test(line)) {
        inVolumes = true;
        continue;
      }
      if (/^ {2}[a-z0-9-]+:\s*$/i.test(line)) {
        inBridge = false;
      }
      continue;
    }

    const volumeMatch = line.match(/^ {6}-\s+(.*)$/);
    if (volumeMatch) {
      volumes.push(volumeMatch[1]);
      continue;
    }

    if (/^ {4}[a-z0-9-]+:\s*$/i.test(line) || /^ {2}[a-z0-9-]+:\s*$/i.test(line)) {
      break;
    }
  }

  return volumes;
}

describe("config.ts ↔ docker-compose env parity", () => {
  it("extracts bridge runtime env vars from config.ts across process.env, env(), and csv() call sites", () => {
    const keys = extractRuntimeEnvKeysFromConfig(configSource);

    expect(keys).toEqual(expect.arrayContaining([
      "PI_THINKING_LEVEL",
      "NEXTCLOUD_BASE_URL",
      "NEXTCLOUD_BOT_SECRET",
      "CODE_SERVER_EXTENSIONS",
      "SANDBOX_CWD",
      "BRIDGE_RUNTIME_UID",
      "BRIDGE_RUNTIME_GID",
      "BRIDGE_DOCKER_SOCKET_GID",
    ]));
  });

  it("passes every bridge runtime env var from config.ts through docker-compose bridge.environment", () => {
    const configKeys = extractRuntimeEnvKeysFromConfig(configSource);
    const composeKeys = new Set(extractBridgeComposeEnvKeys(composeSource));
    const missing = configKeys.filter((key) => !composeKeys.has(key));

    expect(missing, `Missing docker-compose bridge environment passthrough for: ${missing.join(", ")}`).toEqual([]);
  });

  it("derives the projects host-path volume default from BRIDGE_DATA_HOST_DIR", () => {
    const volumes = extractBridgeVolumeLines(composeSource);

    expect(volumes).toContain(
      "${PROJECTS_HOST_DIR:-${BRIDGE_DATA_HOST_DIR:-./bridge-data}/projects}:${PROJECTS_DIR:-/bridge-data/projects}",
    );
  });

  it("keeps the advanced runtime identity override explicit in docker-compose", () => {
    expect(composeSource).toContain('user: "${BRIDGE_RUNTIME_UID:-0}:${BRIDGE_RUNTIME_GID:-0}"');
    expect(composeSource).toContain('group_add:');
    expect(composeSource).toContain('- "${BRIDGE_DOCKER_SOCKET_GID:-0}"');
  });
});
