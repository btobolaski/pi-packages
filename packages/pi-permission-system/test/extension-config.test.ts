import { describe, expect, it } from "vitest";

import {
  detectMisplacedPermissionKeys,
  normalizeOptionalPositiveInt,
  normalizePermissionSystemConfig,
} from "#src/extension-config";

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

describe("normalizeOptionalPositiveInt", () => {
  it("returns the value for a valid positive integer", () => {
    expect(normalizeOptionalPositiveInt(1)).toBe(1);
    expect(normalizeOptionalPositiveInt(200)).toBe(200);
    expect(normalizeOptionalPositiveInt(9999)).toBe(9999);
  });

  it("returns undefined for zero", () => {
    expect(normalizeOptionalPositiveInt(0)).toBeUndefined();
  });

  it("returns undefined for negative integers", () => {
    expect(normalizeOptionalPositiveInt(-1)).toBeUndefined();
    expect(normalizeOptionalPositiveInt(-100)).toBeUndefined();
  });

  it("returns undefined for non-integer numbers (floats)", () => {
    expect(normalizeOptionalPositiveInt(400.5)).toBeUndefined();
    expect(normalizeOptionalPositiveInt(1.1)).toBeUndefined();
  });

  it("returns undefined for non-number types", () => {
    expect(normalizeOptionalPositiveInt("200")).toBeUndefined();
    expect(normalizeOptionalPositiveInt(true)).toBeUndefined();
    expect(normalizeOptionalPositiveInt(null)).toBeUndefined();
    expect(normalizeOptionalPositiveInt(undefined)).toBeUndefined();
    expect(normalizeOptionalPositiveInt({})).toBeUndefined();
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

  it("coerces non-boolean values to their defaults", () => {
    const result = normalizePermissionSystemConfig({
      debugLog: "yes",
      permissionReviewLog: 1,
      yoloMode: null,
    });
    expect(result.debugLog).toBe(false);
    expect(result.permissionReviewLog).toBe(true);
    expect(result.yoloMode).toBe(false);
  });

  it("handles null/undefined input gracefully", () => {
    const result = normalizePermissionSystemConfig(null);
    expect(result).toEqual({
      debugLog: false,
      permissionReviewLog: true,
      yoloMode: false,
      allowLocalEdits: false,
      allowWebAccess: false,
      allowedFetchDomains: [],
    });
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

  it("omits toolInputPreviewMaxLength for invalid values", () => {
    expect(
      normalizePermissionSystemConfig({ toolInputPreviewMaxLength: 0 })
        .toolInputPreviewMaxLength,
    ).toBeUndefined();
    expect(
      normalizePermissionSystemConfig({ toolInputPreviewMaxLength: -1 })
        .toolInputPreviewMaxLength,
    ).toBeUndefined();
    expect(
      normalizePermissionSystemConfig({ toolInputPreviewMaxLength: 200.5 })
        .toolInputPreviewMaxLength,
    ).toBeUndefined();
    expect(
      normalizePermissionSystemConfig({ toolInputPreviewMaxLength: "200" })
        .toolInputPreviewMaxLength,
    ).toBeUndefined();
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

  it("omits toolTextSummaryMaxLength for invalid values", () => {
    expect(
      normalizePermissionSystemConfig({ toolTextSummaryMaxLength: 0 })
        .toolTextSummaryMaxLength,
    ).toBeUndefined();
    expect(
      normalizePermissionSystemConfig({ toolTextSummaryMaxLength: -1 })
        .toolTextSummaryMaxLength,
    ).toBeUndefined();
    expect(
      normalizePermissionSystemConfig({ toolTextSummaryMaxLength: 80.1 })
        .toolTextSummaryMaxLength,
    ).toBeUndefined();
    expect(
      normalizePermissionSystemConfig({ toolTextSummaryMaxLength: true })
        .toolTextSummaryMaxLength,
    ).toBeUndefined();
  });
});
