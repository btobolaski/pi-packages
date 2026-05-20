import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalConfigPath } from "#src/config-paths";
import { ConfigStore } from "#src/config-store";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "pi-permission-config-save-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const configPath = getGlobalConfigPath(agentDir);
  const notify = vi.fn();
  const store = new ConfigStore({
    agentDir,
    policyPaths: {
      getResolvedPolicyPaths: () => ({
        globalConfigPath: configPath,
        globalConfigExists: true,
        projectConfigPath: null,
        projectConfigExists: false,
        agentsDir: join(agentDir, "agents"),
        agentsDirExists: false,
        projectAgentsDir: null,
        projectAgentsDirExists: false,
      }),
    },
    logger: { debug: vi.fn(), review: vi.fn() },
  });
  const ctx = {
    ui: { notify, setStatus: vi.fn() },
  } as unknown as ExtensionCommandContext;
  return { root, configPath, notify, store, ctx };
}

describe("ConfigStore symlink-preserving save", () => {
  it("writes through a valid config symlink without replacing it", () => {
    const { root, configPath, store, ctx } = makeHarness();
    const targetPath = join(root, "dotfiles", "permission-system.json");
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(
      targetPath,
      `${JSON.stringify({ permission: { read: "allow" } }, null, 2)}\n`,
    );
    mkdirSync(dirname(configPath), { recursive: true });
    symlinkSync(targetPath, configPath);

    store.save({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }, ctx);

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(configPath)).toBe(realpathSync(targetPath));
    expect(JSON.parse(readFileSync(targetPath, "utf-8"))).toEqual({
      permission: { read: "allow" },
      debugLog: false,
      permissionReviewLog: true,
      yoloMode: true,
      allowLocalEdits: false,
    });
    expect(
      lstatSync(`${targetPath}.tmp`, { throwIfNoEntry: false }),
    ).toBeUndefined();
  });

  it("refuses to replace a dangling config symlink", () => {
    const { root, configPath, notify, store, ctx } = makeHarness();
    const missingTarget = join(root, "dotfiles", "missing.json");
    mkdirSync(dirname(configPath), { recursive: true });
    symlinkSync(missingTarget, configPath);

    store.save({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }, ctx);

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(missingTarget, { throwIfNoEntry: false })).toBeUndefined();
    expect(store.current()).toEqual(DEFAULT_EXTENSION_CONFIG);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save permission-system config"),
      "error",
    );
  });
});
