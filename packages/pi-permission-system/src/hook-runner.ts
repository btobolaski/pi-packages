import { executePreToolUseHook } from "./hook-executor";
import {
  findMatchingHookCommands,
  piToolNameToClaudeCode,
} from "./hook-matcher";
import type {
  HookExecutionContext,
  HookPermissionDecision,
  MergedHookDecision,
  PreToolUseHookInput,
  PreToolUseHookMatcher,
  PreToolUseHookResult,
} from "./hook-types";

const DECISION_PRIORITY: Record<HookPermissionDecision, number> = {
  deny: 4,
  ask: 3,
  allow: 2,
  defer: 1,
};

/**
 * Merge multiple hook results, picking the highest-priority decision
 * (deny > ask > allow > defer). `updatedInput` and `additionalContext` come
 * from the winning result; `reasons` collects all non-empty reasons.
 */
export function mergeHookDecisions(
  results: PreToolUseHookResult[],
): MergedHookDecision {
  if (results.length === 0) {
    return { decision: "defer", reasons: [] };
  }

  const sorted = [...results].sort(
    (a, b) => DECISION_PRIORITY[b.decision] - DECISION_PRIORITY[a.decision],
  );

  const winner = sorted[0];
  return {
    decision: winner.decision,
    reasons: results
      .map((r) => r.reason)
      .filter((r): r is string => typeof r === "string" && r.length > 0),
    updatedInput: winner.updatedInput,
    additionalContext: winner.additionalContext,
  };
}

/**
 * Run all matching PreToolUse hooks sequentially and merge their decisions.
 * Returns `{ decision: "defer", reasons: [] }` when no hook matches.
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
    return { decision: "defer", reasons: [] };
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
    const result = await executePreToolUseHook(command, hookInput);
    results.push(result);
  }

  return mergeHookDecisions(results);
}
