import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { type ExtensionRuntime, saveExtensionConfig } from "#src/runtime";

/**
 * Build a minimal `ExtensionRuntime` that exercises the real on-disk save
 * path. Only the fields touched by `saveExtensionConfig` are populated.
 */
function makeRuntime(agentDir: string): ExtensionRuntime {
  return {
    agentDir,
    config: { ...DEFAULT_EXTENSION_CONFIG },
    lastConfigWarning: null,
    writeDebugLog: vi.fn(),
    writeReviewLog: vi.fn(),
  } as unknown as ExtensionRuntime;
}

function makeCtx(): ExtensionCommandContext {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("saveExtensionConfig", () => {
  let agentDir: string;
  let globalConfigPath: string;
  let extDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-perm-save-"));
    extDir = join(agentDir, "extensions", "pi-permission-system");
    globalConfigPath = join(extDir, "config.json");
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("preserves a previously-saved hooks block without polluting it with matcherRegex", () => {
    // Seed the global config with a valid hooks block. After save, the file
    // must still be schema-valid: in particular, the hook matcher MUST NOT
    // contain a `matcherRegex` field (which would be JSON-serialized from
    // the runtime's compiled RegExp instance).
    mkdirSync(extDir, { recursive: true });
    const initial = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo hi" }],
          },
        ],
      },
      permission: { read: "allow" },
    };
    writeFileSync(globalConfigPath, JSON.stringify(initial, null, 2));

    const runtime = makeRuntime(agentDir);
    const result = saveExtensionConfig(
      runtime,
      { ...DEFAULT_EXTENSION_CONFIG, debugLog: true },
      makeCtx(),
    );

    expect(result).toBe(true);
    const saved = readJson(globalConfigPath);
    expect(saved.debugLog).toBe(true);
    // The hooks block from disk is carried through unchanged.
    expect(saved.hooks).toEqual(initial.hooks);
    // No accidental serialization of the compiled regex.
    const preToolUse = (saved.hooks as { PreToolUse: unknown[] }).PreToolUse;
    expect(preToolUse[0]).not.toHaveProperty("matcherRegex");
    // Unrelated fields stay intact.
    expect(saved.permission).toEqual({ read: "allow" });
  });

  it("returns true and updates runtime.config on success", () => {
    const runtime = makeRuntime(agentDir);
    const ctx = makeCtx();
    const result = saveExtensionConfig(
      runtime,
      {
        ...DEFAULT_EXTENSION_CONFIG,
        yoloMode: true,
        allowLocalEdits: true,
        allowedFetchDomains: ["Example.COM", "example.com"],
      },
      ctx,
    );

    expect(result).toBe(true);
    expect(runtime.config.yoloMode).toBe(true);
    expect(runtime.config.allowLocalEdits).toBe(true);
    // Persisted list is lowercased + deduped via normalization.
    expect(runtime.config.allowedFetchDomains).toEqual(["example.com"]);
    const saved = readJson(globalConfigPath);
    expect(saved.yoloMode).toBe(true);
    expect(saved.allowLocalEdits).toBe(true);
    expect(saved.allowedFetchDomains).toEqual(["example.com"]);
  });

  it("writes through a symlinked config path instead of replacing the symlink", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "pi-perm-save-target-"));
    try {
      const realConfigPath = join(targetDir, "real-config.json");
      writeFileSync(
        realConfigPath,
        `${JSON.stringify({ permission: { read: "allow" } }, null, 2)}\n`,
      );
      mkdirSync(extDir, { recursive: true });
      symlinkSync(realConfigPath, globalConfigPath);

      const runtime = makeRuntime(agentDir);
      const result = saveExtensionConfig(
        runtime,
        { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
        makeCtx(),
      );

      expect(result).toBe(true);
      expect(lstatSync(globalConfigPath).isSymbolicLink()).toBe(true);
      expect(realpathSync(globalConfigPath)).toBe(realpathSync(realConfigPath));
      expect(readJson(realConfigPath)).toEqual({
        permission: { read: "allow" },
        ...DEFAULT_EXTENSION_CONFIG,
        yoloMode: true,
      });
      expect(
        lstatSync(`${realConfigPath}.tmp`, { throwIfNoEntry: false }),
      ).toBeUndefined();
      expect(
        lstatSync(`${globalConfigPath}.tmp`, { throwIfNoEntry: false }),
      ).toBeUndefined();
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("refuses to replace a dangling config symlink", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "pi-perm-save-dangling-"));
    try {
      const missingTarget = join(targetDir, "does-not-exist.json");
      mkdirSync(extDir, { recursive: true });
      symlinkSync(missingTarget, globalConfigPath);

      const runtime = makeRuntime(agentDir);
      const beforeConfig = { ...runtime.config };
      const ctx = makeCtx();
      const result = saveExtensionConfig(
        runtime,
        { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
        ctx,
      );

      expect(result).toBe(false);
      expect(runtime.config).toEqual(beforeConfig);
      expect(lstatSync(globalConfigPath).isSymbolicLink()).toBe(true);
      expect(
        lstatSync(missingTarget, { throwIfNoEntry: false }),
      ).toBeUndefined();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Failed to save permission-system config"),
        "error",
      );
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("returns false and leaves runtime.config unchanged when the write fails", () => {
    const runtime = makeRuntime(agentDir);
    const beforeConfig = { ...runtime.config };
    const ctx = makeCtx();

    // Force the underlying write to fail by replacing the extension
    // directory with a regular file: `mkdirSync` recursively will refuse
    // because a non-directory already exists at that path.
    mkdirSync(extDir, { recursive: true });
    rmdirSync(extDir);
    writeFileSync(extDir, "not a directory");

    const result = saveExtensionConfig(
      runtime,
      { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
      ctx,
    );

    expect(result).toBe(false);
    expect(runtime.config).toEqual(beforeConfig);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save permission-system config"),
      "error",
    );
  });
});
