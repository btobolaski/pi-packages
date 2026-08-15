import { executePreToolUseHook } from "#src/hook-executor";
import {
  findMatchingHookCommands,
  piToolNameToClaudeCode,
} from "#src/hook-matcher";
import type {
  HookExecutionContext,
  HookPermissionDecision,
  MergedHookDecision,
  PreToolUseHookInput,
  PreToolUseHookMatcher,
  PreToolUseHookResult,
} from "#src/hook-types";

const DECISION_PRIORITY: Record<HookPermissionDecision, number> = {
  deny: 4,
  ask: 3,
  allow: 2,
  defer: 1,
};

/**
 * Merge multiple hook results, picking the highest-priority decision
 * (deny > ask > allow > defer). `updatedInput` and `additionalContext` come
 * from the winning result; `reasons` collects non-empty reasons only from
 * results with the winning decision.
 */
export function mergeHookDecisions(
  results: PreToolUseHookResult[],
): MergedHookDecision {
  if (results.length === 0) {
    return { decision: "defer", reasons: [], diagnostics: [] };
  }

  const sorted = [...results].sort(
    (a, b) => DECISION_PRIORITY[b.decision] - DECISION_PRIORITY[a.decision],
  );

  const winner = sorted[0];
  return {
    decision: winner.decision,
    reasons: results
      .filter((result) => result.decision === winner.decision)
      .map((result) => result.reason)
      .filter((reason): reason is string =>
        Boolean(reason && reason.length > 0),
      ),
    diagnostics: results.map((result) => ({
      decision: result.decision,
      status: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hasStderr: Boolean(result.stderr),
    })),
    updatedInput: winner.updatedInput,
    additionalContext: winner.additionalContext,
  };
}

/**
 * Run all matching PreToolUse hooks sequentially and merge their decisions.
 * Returns `{ decision: "defer", reasons: [], diagnostics: [] }` when no hook
 * matches.
 */
export async function runPreToolUseHooks(
  matchers: PreToolUseHookMatcher[],
  piToolName: string,
  input: unknown,
  context: HookExecutionContext,
  toolUseId: string,
): Promise<MergedHookDecision> {
  const claudeCodeToolName = piToolNameToClaudeCode(piToolName, input);
  const commands = findMatchingHookCommands(
    matchers,
    claudeCodeToolName,
    input,
  );

  if (commands.length === 0) {
    return { decision: "defer", reasons: [], diagnostics: [] };
  }

  const hookInput: PreToolUseHookInput = {
    session_id: context.session_id,
    cwd: context.cwd,
    permission_mode: context.permission_mode,
    hook_event_name: "PreToolUse",
    tool_name: claudeCodeToolName,
    tool_input: input,
    tool_use_id: toolUseId,
    transcript_path: context.transcript_path,
  };

  const results: PreToolUseHookResult[] = [];
  for (const command of commands) {
    const result = await executePreToolUseHook(
      command,
      hookInput,
      context.useProcessGroup,
    );
    results.push(result);
  }

  return mergeHookDecisions(results);
}
