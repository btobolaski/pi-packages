import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { executePreToolUseHook } from "#src/hook-executor";
import type { PreToolUseHookInput } from "#src/hook-types";

/**
 * Build a minimal hook input. The executor only feeds this object to stdin
 * verbatim; it does not inspect any specific field.
 */
function makeInput(
  overrides?: Partial<PreToolUseHookInput>,
): PreToolUseHookInput {
  return {
    session_id: "sess-1",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "tc-1",
    transcript_path: "/tmp/transcript",
    ...overrides,
  };
}

describe("executePreToolUseHook", () => {
  it("returns the parsed decision when the hook prints valid JSON and exits 0", async () => {
    const result = await executePreToolUseHook(
      {
        type: "command",
        command:
          'printf \'{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"ok"}}\'',
      },
      makeInput(),
    );

    expect(result.decision).toBe("allow");
    expect(result.status).toBe("decision");
    expect(result.reason).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("returns deny with stderr as reason when the hook exits with code 2", async () => {
    const result = await executePreToolUseHook(
      {
        type: "command",
        command: 'printf "policy violation" >&2; exit 2',
      },
      makeInput(),
    );

    expect(result.decision).toBe("deny");
    expect(result.status).toBe("decision");
    expect(result.reason).toBe("policy violation");
    expect(result.exitCode).toBe(2);
  });

  it("uses a default deny reason when stderr is empty on exit 2", async () => {
    const result = await executePreToolUseHook(
      { type: "command", command: "exit 2" },
      makeInput(),
    );

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("Hook blocked this tool call (exit code 2)");
  });

  it("defers when stdout is empty and exit code is 0", async () => {
    const result = await executePreToolUseHook(
      { type: "command", command: "exit 0" },
      makeInput(),
    );

    expect(result.decision).toBe("defer");
    expect(result.status).toBe("empty_output");
    expect(result.exitCode).toBe(0);
  });

  it("defers when stdout is non-JSON garbage", async () => {
    const result = await executePreToolUseHook(
      { type: "command", command: 'printf "not json at all"' },
      makeInput(),
    );

    expect(result.decision).toBe("defer");
    expect(result.status).toBe("invalid_output");
  });

  it("defers when the JSON lacks a valid permissionDecision", async () => {
    const result = await executePreToolUseHook(
      {
        type: "command",
        command:
          'printf \'{"hookSpecificOutput":{"permissionDecision":"maybe"}}\'',
      },
      makeInput(),
    );

    expect(result.decision).toBe("defer");
    expect(result.status).toBe("invalid_output");
  });

  it("defers for arbitrary non-zero exit codes", async () => {
    const result = await executePreToolUseHook(
      { type: "command", command: "exit 3" },
      makeInput(),
    );

    expect(result.decision).toBe("defer");
    expect(result.status).toBe("nonzero_exit");
    expect(result.exitCode).toBe(3);
  });

  it("times out and defers when the hook runs longer than the configured timeout", async () => {
    const result = await executePreToolUseHook(
      { type: "command", command: "sleep 2", timeout: 0.1 },
      makeInput(),
    );

    expect(result.decision).toBe("defer");
    expect(result.status).toBe("timeout");
    expect(result.timedOut).toBe(true);
  });

  it("force-kills a timed-out hook that ignores SIGTERM", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pi-hook-timeout-"));
    const pidPath = join(testDir, "pid");

    try {
      await executePreToolUseHook(
        {
          type: "command",
          command: `trap '' TERM; printf '%s' "$$" > '${pidPath}'; while :; do sleep 1; done`,
          timeout: 0.05,
        },
        makeInput(),
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));

      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("preserves updatedInput and additionalContext from the parsed output", async () => {
    const payload = {
      hookSpecificOutput: {
        permissionDecision: "allow",
        permissionDecisionReason: "rewriting",
        updatedInput: { command: "ls -la" },
        additionalContext: "post-processed",
      },
    };
    const result = await executePreToolUseHook(
      {
        type: "command",
        command: `printf '${JSON.stringify(payload)}'`,
      },
      makeInput(),
    );

    expect(result.decision).toBe("allow");
    expect(result.updatedInput).toEqual({ command: "ls -la" });
    expect(result.additionalContext).toBe("post-processed");
  });

  it("runs relative hook commands from the session cwd", async () => {
    const result = await executePreToolUseHook(
      {
        type: "command",
        command:
          'test "$PWD" = "/tmp" && printf \'{"hookSpecificOutput":{"permissionDecision":"allow"}}\'',
      },
      makeInput({ cwd: "/tmp" }),
    );

    expect(result.decision).toBe("allow");
  });

  it("omits the transcript path when no session file exists", async () => {
    const result = await executePreToolUseHook(
      {
        type: "command",
        command:
          'grep -q \'"transcript_path"\' && exit 2; printf \'{"hookSpecificOutput":{"permissionDecision":"allow"}}\'',
      },
      makeInput({ transcript_path: undefined }),
    );

    expect(result.decision).toBe("allow");
  });

  it("forwards the JSON payload on stdin so hooks can inspect it", async () => {
    // The hook command uses `grep -q` to assert that stdin contains the
    // marker `session_id` value, then emits a JSON allow decision. If stdin
    // had not been forwarded, grep would exit non-zero and the executor
    // would fall through to the `defer` branch.
    const input = makeInput({ session_id: "sess-XYZ" });
    const result = await executePreToolUseHook(
      {
        type: "command",
        command:
          'grep -q "sess-XYZ" && printf \'{"hookSpecificOutput":{"permissionDecision":"allow"}}\'',
      },
      input,
    );

    expect(result.decision).toBe("allow");
  });
});
