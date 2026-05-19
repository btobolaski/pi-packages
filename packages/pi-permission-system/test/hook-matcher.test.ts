import { describe, expect, it } from "vitest";

import {
  findMatchingHookCommands,
  piToolNameToClaudeCode,
} from "#src/hook-matcher";
import { normalizeHookMatcher } from "#src/hook-normalize";
import type { PreToolUseHookMatcher } from "#src/hook-types";

function buildMatcher(raw: unknown): PreToolUseHookMatcher {
  const matcher = normalizeHookMatcher(raw);
  if (!matcher) throw new Error("expected normalizeHookMatcher to succeed");
  return matcher;
}

describe("piToolNameToClaudeCode", () => {
  it("maps built-in tools to Claude Code names", () => {
    expect(piToolNameToClaudeCode("bash", {})).toBe("Bash");
    expect(piToolNameToClaudeCode("read", {})).toBe("Read");
    expect(piToolNameToClaudeCode("write", {})).toBe("Write");
    expect(piToolNameToClaudeCode("edit", {})).toBe("Edit");
    expect(piToolNameToClaudeCode("grep", {})).toBe("Grep");
    expect(piToolNameToClaudeCode("find", {})).toBe("Glob");
    expect(piToolNameToClaudeCode("ls", {})).toBe("LS");
    expect(piToolNameToClaudeCode("skill", {})).toBe("Skill");
  });

  it("returns the original name when no mapping exists", () => {
    expect(piToolNameToClaudeCode("custom_tool", {})).toBe("custom_tool");
  });

  it("derives mcp__server__tool from `tool: server:tool` input", () => {
    expect(piToolNameToClaudeCode("mcp", { tool: "github:list_issues" })).toBe(
      "mcp__github__list_issues",
    );
  });

  it("derives mcp__server__tool from separate server + tool fields", () => {
    expect(
      piToolNameToClaudeCode("mcp", { server: "github", tool: "list_issues" }),
    ).toBe("mcp__github__list_issues");
  });

  it("falls back to mcp__server when only server is known", () => {
    expect(piToolNameToClaudeCode("mcp", { server: "github" })).toBe(
      "mcp__github",
    );
  });

  it("falls back to bare `mcp` when nothing is parseable", () => {
    expect(piToolNameToClaudeCode("mcp", {})).toBe("mcp");
  });
});

describe("findMatchingHookCommands", () => {
  it("includes hooks whose matcher regex matches the tool name", () => {
    const matcher = buildMatcher({
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo hi" }],
    });
    expect(findMatchingHookCommands([matcher], "Bash", {})).toHaveLength(1);
    expect(findMatchingHookCommands([matcher], "Read", {})).toHaveLength(0);
  });

  it("supports regex alternation via the compiled matcher", () => {
    const matcher = buildMatcher({
      matcher: "Bash|Read",
      hooks: [{ type: "command", command: "echo hi" }],
    });
    expect(findMatchingHookCommands([matcher], "Bash", {})).toHaveLength(1);
    expect(findMatchingHookCommands([matcher], "Read", {})).toHaveLength(1);
    expect(findMatchingHookCommands([matcher], "Edit", {})).toHaveLength(0);
  });

  it("applies an if-clause against the bash command field", () => {
    const matcher = buildMatcher({
      matcher: "Bash",
      hooks: [{ type: "command", command: "block", if: "Bash(rm -rf *)" }],
    });
    expect(
      findMatchingHookCommands([matcher], "Bash", { command: "rm -rf /" }),
    ).toHaveLength(1);
    expect(
      findMatchingHookCommands([matcher], "Bash", { command: "ls" }),
    ).toHaveLength(0);
  });

  it("applies an if-clause against file_path for Edit/Write/Read", () => {
    const matcher = buildMatcher({
      matcher: "Edit",
      hooks: [
        {
          type: "command",
          command: "block",
          if: "Edit(*/secret.ts)",
        },
      ],
    });
    expect(
      findMatchingHookCommands([matcher], "Edit", {
        file_path: "/home/u/secret.ts",
      }),
    ).toHaveLength(1);
    expect(
      findMatchingHookCommands([matcher], "Edit", {
        file_path: "/home/u/foo.ts",
      }),
    ).toHaveLength(0);
  });

  it("skips a hook when the if-clause tool does not match", () => {
    const matcher = buildMatcher({
      matcher: "Bash",
      hooks: [{ type: "command", command: "block", if: "Edit(*)" }],
    });
    expect(
      findMatchingHookCommands([matcher], "Bash", { command: "ls" }),
    ).toHaveLength(0);
  });
});
