import { describe, expect, it } from "vitest";
import { normalizeHookMatcher } from "#src/hook-normalize";
import { mergeHookDecisions, runPreToolUseHooks } from "#src/hook-runner";
import type {
  HookExecutionContext,
  PreToolUseHookMatcher,
  PreToolUseHookResult,
} from "#src/hook-types";

function buildMatcher(raw: unknown): PreToolUseHookMatcher {
  const matcher = normalizeHookMatcher(raw);
  if (!matcher) throw new Error("expected normalizeHookMatcher to succeed");
  return matcher;
}

const ctx: HookExecutionContext = {
  session_id: "session-1",
  cwd: "/tmp",
  permission_mode: "default",
  transcript_path: "/tmp/transcript",
};

function res(
  decision: PreToolUseHookResult["decision"],
  reason?: string,
): PreToolUseHookResult {
  return { decision, reason, exitCode: 0, timedOut: false };
}

describe("mergeHookDecisions", () => {
  it("returns defer when no results are given", () => {
    expect(mergeHookDecisions([])).toEqual({ decision: "defer", reasons: [] });
  });

  it("picks deny over ask, allow, and defer", () => {
    const merged = mergeHookDecisions([
      res("allow", "ok"),
      res("ask", "maybe"),
      res("deny", "no"),
      res("defer"),
    ]);
    expect(merged.decision).toBe("deny");
    expect(merged.reasons).toEqual(["ok", "maybe", "no"]);
  });

  it("picks ask over allow and defer", () => {
    const merged = mergeHookDecisions([res("allow"), res("ask"), res("defer")]);
    expect(merged.decision).toBe("ask");
  });

  it("carries updatedInput / additionalContext from the winning entry", () => {
    const merged = mergeHookDecisions([
      { decision: "allow", exitCode: 0, timedOut: false, updatedInput: "lo" },
      {
        decision: "deny",
        exitCode: 0,
        timedOut: false,
        reason: "no",
        updatedInput: "hi",
        additionalContext: "ctx",
      },
    ]);
    expect(merged.decision).toBe("deny");
    expect(merged.updatedInput).toBe("hi");
    expect(merged.additionalContext).toBe("ctx");
  });
});

describe("runPreToolUseHooks", () => {
  it("returns defer when no matchers fire", async () => {
    const matcher = buildMatcher({
      matcher: "Read",
      hooks: [{ type: "command", command: "exit 0" }],
    });
    const result = await runPreToolUseHooks([matcher], "bash", {}, ctx, "t1");
    expect(result).toEqual({ decision: "defer", reasons: [] });
  });

  it("executes a hook command and merges its allow decision", async () => {
    const matcher = buildMatcher({
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command:
            'printf \'%s\' \'{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"ok"}}\'',
        },
      ],
    });
    const result = await runPreToolUseHooks(
      [matcher],
      "bash",
      { command: "ls" },
      ctx,
      "tool-call-1",
    );
    expect(result.decision).toBe("allow");
    expect(result.reasons).toEqual(["ok"]);
  });

  it("maps exit code 2 to deny with stderr as reason", async () => {
    const matcher = buildMatcher({
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: "echo blocked >&2; exit 2",
        },
      ],
    });
    const result = await runPreToolUseHooks(
      [matcher],
      "bash",
      { command: "ls" },
      ctx,
      "tool-call-1",
    );
    expect(result.decision).toBe("deny");
    expect(result.reasons[0]).toContain("blocked");
  });

  it("treats empty stdout from a successful command as defer", async () => {
    const matcher = buildMatcher({
      matcher: "Bash",
      hooks: [{ type: "command", command: "exit 0" }],
    });
    const result = await runPreToolUseHooks(
      [matcher],
      "bash",
      { command: "ls" },
      ctx,
      "tool-call-1",
    );
    expect(result.decision).toBe("defer");
  });
});
