import { describe, expect, it } from "vitest";

import type { PermissionSystemExtensionConfig } from "#src/extension-config";
import {
  detectMisplacedPermissionKeys,
  isYoloModeEnabled,
  normalizePermissionSystemConfig,
} from "#src/extension-config";

function makeConfig(
  yoloMode: boolean | undefined,
): PermissionSystemExtensionConfig {
  return { yoloMode } as PermissionSystemExtensionConfig;
}

describe("detectMisplacedPermissionKeys", () => {
  it("returns an empty array for a record with only valid extension keys", () => {
    const result = detectMisplacedPermissionKeys({
      debugLog: true,
      permissionReviewLog: true,
      yoloMode: false,
    });
    expect(result).toEqual([]);
  });

  it("returns an empty array for an empty record", () => {
    const result = detectMisplacedPermissionKeys({});
    expect(result).toEqual([]);
  });

  it("returns misplaced key names when legacy permission-rule keys are present", () => {
    const result = detectMisplacedPermissionKeys({
      debugLog: true,
      defaultPolicy: { tools: "ask" },
      bash: { "git status": "allow" },
    });
    expect(result).toEqual(["defaultPolicy", "bash"]);
  });

  it("detects all known legacy permission-rule keys", () => {
    const result = detectMisplacedPermissionKeys({
      defaultPolicy: {},
      tools: {},
      bash: {},
      mcp: {},
      skills: {},
      special: {},
      external_directory: {},
    });
    expect(result).toEqual([
      "defaultPolicy",
      "tools",
      "bash",
      "mcp",
      "skills",
      "special",
      "external_directory",
    ]);
  });

  it("does not detect doom_loop as a misplaced permission key", () => {
    const result = detectMisplacedPermissionKeys({
      doom_loop: {},
    });
    expect(result).toEqual([]);
  });

  it("does not flag the new flat-format permission key as misplaced", () => {
    const result = detectMisplacedPermissionKeys({
      debugLog: false,
      permission: { "*": "ask" },
    });
    expect(result).toEqual([]);
  });

  it("ignores unknown keys that are not permission-rule keys", () => {
    const result = detectMisplacedPermissionKeys({
      debugLog: true,
      someRandomKey: "value",
    });
    expect(result).toEqual([]);
  });
});

describe("normalizePermissionSystemConfig", () => {
  it("normalizes a valid config object", () => {
    const result = normalizePermissionSystemConfig({
      debugLog: true,
      permissionReviewLog: false,
      yoloMode: true,
    });
    expect(result).toEqual({
      debugLog: true,
      permissionReviewLog: false,
      yoloMode: true,
      allowLocalEdits: false,
      allowWebAccess: false,
      allowedFetchDomains: [],
    });
  });

  it("defaults debugLog to false when missing", () => {
    const result = normalizePermissionSystemConfig({});
    expect(result.debugLog).toBe(false);
  });

  it("defaults permissionReviewLog to true when missing", () => {
    const result = normalizePermissionSystemConfig({});
    expect(result.permissionReviewLog).toBe(true);
  });

  it("defaults yoloMode to false when missing", () => {
    const result = normalizePermissionSystemConfig({});
    expect(result.yoloMode).toBe(false);
  });

  it("normalizes local-edit and web-access settings", () => {
    const result = normalizePermissionSystemConfig({
      allowLocalEdits: true,
      allowWebAccess: true,
      allowedFetchDomains: ["Example.COM", "example.com", " docs.test "],
    });
    expect(result.allowLocalEdits).toBe(true);
    expect(result.allowWebAccess).toBe(true);
    expect(result.allowedFetchDomains).toEqual(["example.com", "docs.test"]);
  });

  it("compiles configured PreToolUse matchers", () => {
    const result = normalizePermissionSystemConfig({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|Read",
            hooks: [{ type: "command", command: "echo check" }],
          },
        ],
      },
    });
    expect(result.hooks?.PreToolUse).toHaveLength(1);
    expect(result.hooks?.PreToolUse?.[0]?.matcherRegex.test("Bash")).toBe(true);
  });

  it("includes toolInputPreviewMaxLength when a valid positive integer is provided", () => {
    const result = normalizePermissionSystemConfig({
      toolInputPreviewMaxLength: 400,
    });
    expect(result.toolInputPreviewMaxLength).toBe(400);
  });

  it("omits toolInputPreviewMaxLength when absent", () => {
    const result = normalizePermissionSystemConfig({});
    expect("toolInputPreviewMaxLength" in result).toBe(false);
  });

  it("includes toolTextSummaryMaxLength when a valid positive integer is provided", () => {
    const result = normalizePermissionSystemConfig({
      toolTextSummaryMaxLength: 120,
    });
    expect(result.toolTextSummaryMaxLength).toBe(120);
  });

  it("omits toolTextSummaryMaxLength when absent", () => {
    const result = normalizePermissionSystemConfig({});
    expect("toolTextSummaryMaxLength" in result).toBe(false);
  });
});

describe("isYoloModeEnabled", () => {
  it("returns true when yoloMode is true", () => {
    expect(isYoloModeEnabled(makeConfig(true))).toBe(true);
  });

  it("returns false when yoloMode is false", () => {
    expect(isYoloModeEnabled(makeConfig(false))).toBe(false);
  });

  it("returns false when yoloMode is undefined", () => {
    expect(isYoloModeEnabled(makeConfig(undefined))).toBe(false);
  });
});
