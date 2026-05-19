import { homedir } from "node:os";
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import {
  extractNormalizedFilePath,
  isPathWithinDirectory,
  normalizePathForComparison,
  shouldAllowLocalEdit,
} from "#src/local-edit";

const CWD = process.platform === "win32" ? "C:\\project" : "/project";

const allowConfig = { ...DEFAULT_EXTENSION_CONFIG, allowLocalEdits: true };

describe("normalizePathForComparison", () => {
  it("returns absolute path when input is already absolute", () => {
    const input = process.platform === "win32" ? "C:\\foo\\bar" : "/foo/bar";
    const expected = process.platform === "win32" ? "c:\\foo\\bar" : "/foo/bar";
    expect(normalizePathForComparison(input, CWD)).toBe(expected);
  });

  it("resolves relative paths against cwd", () => {
    const result = normalizePathForComparison("src/file.ts", CWD);
    expect(result.endsWith(`src${sep}file.ts`)).toBe(true);
  });

  it("strips surrounding quotes and a leading @", () => {
    const result = normalizePathForComparison('"@src/file.ts"', CWD);
    expect(result.endsWith(`src${sep}file.ts`)).toBe(true);
  });

  it("expands a leading ~ to the user home directory", () => {
    const result = normalizePathForComparison("~/foo.ts", CWD);
    expect(
      result.startsWith(homedir().toLowerCase()) ||
        result.startsWith(homedir()),
    ).toBe(true);
    expect(result.endsWith(`foo.ts`)).toBe(true);
  });

  it("returns an empty string for blank input", () => {
    expect(normalizePathForComparison("   ", CWD)).toBe("");
  });
});

describe("isPathWithinDirectory", () => {
  it("returns true when path equals the directory", () => {
    expect(isPathWithinDirectory(CWD, CWD)).toBe(true);
  });

  it("returns true for a child path", () => {
    expect(isPathWithinDirectory(`${CWD}${sep}src${sep}a.ts`, CWD)).toBe(true);
  });

  it("does not false-positive on shared prefixes", () => {
    const sibling =
      process.platform === "win32" ? "C:\\project-foo" : "/project-foo";
    expect(isPathWithinDirectory(sibling, CWD)).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(isPathWithinDirectory("", CWD)).toBe(false);
    expect(isPathWithinDirectory(CWD, "")).toBe(false);
  });
});

describe("extractNormalizedFilePath", () => {
  it("reads from file_path", () => {
    const result = extractNormalizedFilePath({ file_path: "src/a.ts" }, CWD);
    expect(result?.endsWith(`src${sep}a.ts`)).toBe(true);
  });

  it("falls back to path when file_path is absent", () => {
    const result = extractNormalizedFilePath({ path: "src/b.ts" }, CWD);
    expect(result?.endsWith(`src${sep}b.ts`)).toBe(true);
  });

  it("returns null for missing or non-string fields", () => {
    expect(extractNormalizedFilePath({}, CWD)).toBeNull();
    expect(extractNormalizedFilePath({ file_path: 42 }, CWD)).toBeNull();
    expect(extractNormalizedFilePath({ file_path: "   " }, CWD)).toBeNull();
    expect(extractNormalizedFilePath(null, CWD)).toBeNull();
  });
});

describe("shouldAllowLocalEdit", () => {
  it("returns true for edit inside cwd when allowLocalEdits is on", () => {
    const result = shouldAllowLocalEdit(
      "edit",
      { file_path: "src/a.ts" },
      CWD,
      allowConfig,
    );
    expect(result).toBe(true);
  });

  it("returns true for write inside cwd when allowLocalEdits is on", () => {
    const result = shouldAllowLocalEdit(
      "write",
      { path: "src/b.ts" },
      CWD,
      allowConfig,
    );
    expect(result).toBe(true);
  });

  it("returns false when allowLocalEdits is off", () => {
    const result = shouldAllowLocalEdit(
      "edit",
      { file_path: "src/a.ts" },
      CWD,
      DEFAULT_EXTENSION_CONFIG,
    );
    expect(result).toBe(false);
  });

  it("returns false for tools other than edit/write", () => {
    const result = shouldAllowLocalEdit(
      "read",
      { file_path: "src/a.ts" },
      CWD,
      allowConfig,
    );
    expect(result).toBe(false);
  });

  it("returns false for paths outside cwd", () => {
    const outside =
      process.platform === "win32" ? "C:\\elsewhere\\a.ts" : "/elsewhere/a.ts";
    const result = shouldAllowLocalEdit(
      "edit",
      { file_path: outside },
      CWD,
      allowConfig,
    );
    expect(result).toBe(false);
  });

  it("returns false when no file path is present in the input", () => {
    const result = shouldAllowLocalEdit("edit", {}, CWD, allowConfig);
    expect(result).toBe(false);
  });

  it("returns false when a sibling directory shares a prefix", () => {
    const siblingCwd =
      process.platform === "win32" ? "C:\\project-foo" : "/project-foo";
    const sibling =
      process.platform === "win32"
        ? "C:\\project-foo\\a.ts"
        : "/project-foo/a.ts";
    const result = shouldAllowLocalEdit(
      "edit",
      { file_path: sibling },
      CWD,
      allowConfig,
    );
    // sibling is inside its own cwd
    expect(result).toBe(false);
    expect(
      shouldAllowLocalEdit(
        "edit",
        { file_path: sibling },
        siblingCwd,
        allowConfig,
      ),
    ).toBe(true);
  });
});
