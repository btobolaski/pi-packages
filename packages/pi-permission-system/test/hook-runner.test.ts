import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import {
  PreToolUseHookGate,
  type PreToolUseHookRunner,
} from "#src/handlers/gates/pre-tool-use-hook-gate";
import { normalizeHookMatcher } from "#src/hook-normalize";
import { mergeHookDecisions, runPreToolUseHooks } from "#src/hook-runner";
import type {
  HookExecutionContext,
  MergedHookDecision,
  PreToolUseHookMatcher,
  PreToolUseHookResult,
} from "#src/hook-types";
import { makeReporter, makeTcc } from "#test/helpers/gate-fixtures";
import { makeCtx } from "#test/helpers/handler-fixtures";

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
  useProcessGroup: false,
};

function res(
  decision: PreToolUseHookResult["decision"],
  reason?: string,
): PreToolUseHookResult {
  return {
    decision,
    status: "decision",
    reason,
    exitCode: 0,
    timedOut: false,
  };
}

describe("mergeHookDecisions", () => {
  it("returns defer when no results are given", () => {
    expect(mergeHookDecisions([])).toEqual({
      decision: "defer",
      reasons: [],
      diagnostics: [],
    });
  });

  it("picks deny over ask, allow, and defer", () => {
    const merged = mergeHookDecisions([
      res("allow", "ok"),
      res("ask", "maybe"),
      res("deny", "no"),
      res("deny", "also no"),
      res("defer"),
    ]);
    expect(merged.decision).toBe("deny");
    expect(merged.reasons).toEqual(["no", "also no"]);
  });

  it("picks ask over allow and defer", () => {
    const merged = mergeHookDecisions([res("allow"), res("ask"), res("defer")]);
    expect(merged.decision).toBe("ask");
  });

  it("carries updatedInput / additionalContext from the winning entry", () => {
    const merged = mergeHookDecisions([
      {
        decision: "allow",
        status: "decision",
        exitCode: 0,
        timedOut: false,
        updatedInput: "lo",
      },
      {
        decision: "deny",
        status: "decision",
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

describe("PreToolUseHookGate", () => {
  const matcher = buildMatcher({
    matcher: ".*",
    hooks: [{ type: "command", command: "policy-check" }],
  });

  function makeGate(decision: MergedHookDecision) {
    const reporter = makeReporter();
    const runHooks = vi.fn<PreToolUseHookRunner>().mockResolvedValue(decision);
    const gate = new PreToolUseHookGate(
      () => ({
        ...DEFAULT_EXTENSION_CONFIG,
        allowLocalEdits: true,
        hooks: { PreToolUse: [matcher] },
      }),
      reporter,
      false,
      runHooks,
    );
    return { gate, reporter, runHooks };
  }

  it("short-circuits with allow and records hook provenance", async () => {
    const { gate, reporter, runHooks } = makeGate({
      decision: "allow",
      reasons: ["approved by policy hook"],
      diagnostics: [],
    });
    const tcc = makeTcc({ toolCallId: "call-1" });

    const outcome = await gate.evaluate(tcc, makeCtx());

    expect(outcome).toEqual({ action: "allow" });
    expect(runHooks).toHaveBeenCalledWith(
      [matcher],
      "bash",
      tcc.input,
      expect.objectContaining({
        session_id: "session-test",
        cwd: "/test/project",
        permission_mode: "acceptEdits",
        transcript_path: "/sessions/test/session-test.jsonl",
      }),
      "call-1",
    );
    expect(reporter.emitDecision).toHaveBeenCalledWith({
      requestId: expect.any(String),
      surface: "bash",
      value: "cat .env",
      result: "allow",
      resolution: "hook_approved",
      origin: "pretooluse_hook",
      agentName: null,
      matchedPattern: null,
    });
  });

  it("blocks with the hook's denial reason", async () => {
    const { gate, reporter } = makeGate({
      decision: "deny",
      reasons: ["unsafe command"],
      diagnostics: [],
    });

    const outcome = await gate.evaluate(makeTcc(), makeCtx());

    expect(outcome).toEqual({
      action: "block",
      reason: "unsafe command",
    });
    expect(reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "hook_denied",
      }),
    );
  });

  it.each([
    "ask",
    "defer",
  ] as const)("continues to the dialog fallback for %s", async (decision) => {
    const { gate } = makeGate({ decision, reasons: [], diagnostics: [] });

    await expect(gate.evaluate(makeTcc(), makeCtx())).resolves.toEqual({
      action: "continue",
    });
  });

  it("does not record a diagnostic for clean hook decisions", async () => {
    const { gate, reporter } = makeGate({
      decision: "allow",
      reasons: [],
      diagnostics: [
        {
          decision: "allow",
          status: "decision",
          exitCode: 0,
          timedOut: false,
          hasStderr: false,
        },
      ],
    });

    await gate.evaluate(makeTcc(), makeCtx());

    expect(reporter.writeReviewLog).not.toHaveBeenCalledWith(
      "permission_request.hook_diagnostic",
      expect.anything(),
    );
  });

  it("records abnormal hook execution diagnostics before deferring", async () => {
    const { gate, reporter } = makeGate({
      decision: "defer",
      reasons: [],
      diagnostics: [
        {
          decision: "defer",
          status: "invalid_output",
          exitCode: 0,
          timedOut: false,
          hasStderr: true,
        },
      ],
    });

    await gate.evaluate(makeTcc(), makeCtx());

    expect(reporter.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.hook_diagnostic",
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ status: "invalid_output" })],
      }),
    );
  });
});

describe("runPreToolUseHooks", () => {
  it("returns defer when no matchers fire", async () => {
    const matcher = buildMatcher({
      matcher: "Read",
      hooks: [{ type: "command", command: "exit 0" }],
    });
    const result = await runPreToolUseHooks([matcher], "bash", {}, ctx, "t1");
    expect(result).toEqual({
      decision: "defer",
      reasons: [],
      diagnostics: [],
    });
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
