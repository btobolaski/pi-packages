import { describe, expect, it } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { shouldAllowLocalEdit } from "#src/local-edit";
import { posixPathFlavor, win32PathFlavor } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path-normalizer";

const allowConfig = { ...DEFAULT_EXTENSION_CONFIG, allowLocalEdits: true };
const posixNormalizer = new PathNormalizer(posixPathFlavor, "/project");

describe("shouldAllowLocalEdit", () => {
  it("allows edit and write paths inside cwd when enabled", () => {
    expect(
      shouldAllowLocalEdit(
        "edit",
        { path: "src/a.ts" },
        posixNormalizer,
        allowConfig,
      ),
    ).toBe(true);
    expect(
      shouldAllowLocalEdit(
        "write",
        { path: "/project/src/b.ts" },
        posixNormalizer,
        allowConfig,
      ),
    ).toBe(true);
  });

  it("does not allow local edits when the override is disabled", () => {
    expect(
      shouldAllowLocalEdit(
        "edit",
        { path: "src/a.ts" },
        posixNormalizer,
        DEFAULT_EXTENSION_CONFIG,
      ),
    ).toBe(false);
  });

  it("does not apply to tools other than edit and write", () => {
    expect(
      shouldAllowLocalEdit(
        "read",
        { path: "src/a.ts" },
        posixNormalizer,
        allowConfig,
      ),
    ).toBe(false);
  });

  it("rejects paths outside cwd and sibling paths sharing its prefix", () => {
    expect(
      shouldAllowLocalEdit(
        "edit",
        { path: "/elsewhere/a.ts" },
        posixNormalizer,
        allowConfig,
      ),
    ).toBe(false);
    expect(
      shouldAllowLocalEdit(
        "edit",
        { path: "/project-other/a.ts" },
        posixNormalizer,
        allowConfig,
      ),
    ).toBe(false);
  });

  it("rejects tool input without a path", () => {
    expect(shouldAllowLocalEdit("edit", {}, posixNormalizer, allowConfig)).toBe(
      false,
    );
  });

  it("uses the injected Windows path semantics", () => {
    const normalizer = new PathNormalizer(win32PathFlavor, "C:\\Project");
    expect(
      shouldAllowLocalEdit(
        "write",
        { path: "c:\\project\\src\\a.ts" },
        normalizer,
        allowConfig,
      ),
    ).toBe(true);
    expect(
      shouldAllowLocalEdit(
        "write",
        { path: "C:\\Project-Other\\a.ts" },
        normalizer,
        allowConfig,
      ),
    ).toBe(false);
  });
});
