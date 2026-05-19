import { describe, expect, it } from "vitest";

import {
  normalizeHookCommand,
  normalizeHookMatcher,
  normalizeHooksConfig,
} from "#src/hook-normalize";

describe("normalizeHookCommand", () => {
  it("returns a command entry for a valid record", () => {
    expect(
      normalizeHookCommand({
        type: "command",
        command: "echo hi",
        if: "Bash(*)",
        timeout: 5,
      }),
    ).toEqual({
      type: "command",
      command: "echo hi",
      if: "Bash(*)",
      timeout: 5,
    });
  });

  it("omits `if` when blank and `timeout` when not positive", () => {
    expect(
      normalizeHookCommand({
        type: "command",
        command: " echo ",
        if: "  ",
        timeout: 0,
      }),
    ).toEqual({ type: "command", command: "echo" });
  });

  it("returns null for missing or invalid fields", () => {
    expect(normalizeHookCommand(null)).toBeNull();
    expect(normalizeHookCommand({ type: "other", command: "echo" })).toBeNull();
    expect(normalizeHookCommand({ type: "command", command: "" })).toBeNull();
    expect(normalizeHookCommand({ type: "command", command: 42 })).toBeNull();
  });
});

describe("normalizeHookMatcher", () => {
  it("compiles the matcher into a regex and accepts valid hooks", () => {
    const matcher = normalizeHookMatcher({
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo hi" }],
    });
    expect(matcher).not.toBeNull();
    expect(matcher?.matcher).toBe("Bash");
    expect(matcher?.matcherRegex.test("Bash")).toBe(true);
    expect(matcher?.matcherRegex.test("Bashful")).toBe(false);
  });

  it("returns null on invalid regex syntax", () => {
    expect(
      normalizeHookMatcher({
        matcher: "(",
        hooks: [{ type: "command", command: "echo" }],
      }),
    ).toBeNull();
  });

  it("returns null when hooks is not an array or yields no valid commands", () => {
    expect(normalizeHookMatcher({ matcher: "Bash", hooks: "nope" })).toBeNull();
    expect(normalizeHookMatcher({ matcher: "Bash", hooks: [] })).toBeNull();
    expect(
      normalizeHookMatcher({
        matcher: "Bash",
        hooks: [{ type: "command", command: "" }],
      }),
    ).toBeNull();
  });
});

describe("normalizeHooksConfig", () => {
  it("returns a config when at least one matcher is valid", () => {
    const result = normalizeHooksConfig({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "echo hi" }],
        },
      ],
    });
    expect(result?.PreToolUse).toHaveLength(1);
  });

  it("returns undefined when PreToolUse is missing or empty", () => {
    expect(normalizeHooksConfig({})).toBeUndefined();
    expect(normalizeHooksConfig({ PreToolUse: [] })).toBeUndefined();
    expect(normalizeHooksConfig({ PreToolUse: [{}] })).toBeUndefined();
  });

  it("returns undefined when PreToolUse is not an array", () => {
    expect(normalizeHooksConfig({ PreToolUse: "string" })).toBeUndefined();
  });
});
