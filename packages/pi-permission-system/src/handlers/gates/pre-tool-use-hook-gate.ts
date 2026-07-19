import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionReporter } from "#src/decision-reporter";
import {
  deriveHookPermissionMode,
  type PermissionSystemExtensionConfig,
} from "#src/extension-config";
import { runPreToolUseHooks } from "#src/hook-runner";
import type { MergedHookDecision } from "#src/hook-types";
import { getNonEmptyString, toRecord } from "#src/value-guards";
import type { GateOutcome, ToolCallContext } from "./types";

export type PreToolUseHookGateOutcome = { action: "continue" } | GateOutcome;

export type PreToolUseHookRunner = typeof runPreToolUseHooks;

export interface PreToolUseHookEvaluator {
  evaluate(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
  ): Promise<PreToolUseHookGateOutcome>;
}

/**
 * Runs Claude Code-compatible PreToolUse hooks before any built-in gate.
 *
 * Hook allow/deny verdicts are terminal. Ask/defer verdicts continue to the
 * dialog-only fallback pipeline, where a prior user session grant may still
 * apply and every other call reaches the human prompt.
 */
export class PreToolUseHookGate implements PreToolUseHookEvaluator {
  constructor(
    private readonly getConfig: () => PermissionSystemExtensionConfig,
    private readonly reporter: DecisionReporter,
    private readonly runHooks: PreToolUseHookRunner = runPreToolUseHooks,
  ) {}

  async evaluate(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
  ): Promise<PreToolUseHookGateOutcome> {
    const config = this.getConfig();
    const matchers = config.hooks?.PreToolUse;
    if (!matchers || matchers.length === 0) {
      return { action: "continue" };
    }

    const decision = await this.runHooks(
      matchers,
      tcc.toolName,
      tcc.input,
      {
        session_id: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        permission_mode: deriveHookPermissionMode(config),
        transcript_path: ctx.sessionManager.getSessionDir() || "",
      },
      tcc.toolCallId,
    );

    return this.applyDecision(tcc, decision);
  }

  private applyDecision(
    tcc: ToolCallContext,
    decision: MergedHookDecision,
  ): PreToolUseHookGateOutcome {
    switch (decision.decision) {
      case "allow":
        this.report(tcc, decision, "allow", "hook_approved");
        return { action: "allow" };
      case "deny": {
        this.report(tcc, decision, "deny", "hook_denied");
        const reason =
          decision.reasons.length > 0
            ? decision.reasons.join("; ")
            : "Blocked by PreToolUse hook";
        return { action: "block", reason };
      }
      case "ask":
        this.reporter.writeReviewLog(
          "permission_request.hook_requested_confirmation",
          this.reviewDetails(tcc, decision),
        );
        return { action: "continue" };
      case "defer":
        return { action: "continue" };
    }
  }

  private report(
    tcc: ToolCallContext,
    decision: MergedHookDecision,
    result: "allow" | "deny",
    resolution: "hook_approved" | "hook_denied",
  ): void {
    this.reporter.writeReviewLog(
      result === "allow"
        ? "permission_request.hook_approved"
        : "permission_request.blocked",
      {
        ...this.reviewDetails(tcc, decision),
        resolution,
      },
    );
    this.reporter.emitDecision({
      surface: tcc.toolName,
      value: decisionValue(tcc),
      result,
      resolution,
      origin: "pretooluse_hook",
      agentName: tcc.agentName,
      matchedPattern: null,
    });
  }

  private reviewDetails(
    tcc: ToolCallContext,
    decision: MergedHookDecision,
  ): Record<string, unknown> {
    return {
      source: "pretooluse_hook",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      agentName: tcc.agentName,
      hookReasons: decision.reasons,
      updatedInputIgnored: decision.updatedInput !== undefined,
      additionalContextIgnored: decision.additionalContext !== undefined,
    };
  }
}

function decisionValue(tcc: ToolCallContext): string {
  const input = toRecord(tcc.input);
  return (
    getNonEmptyString(input.command) ??
    getNonEmptyString(input.path) ??
    getNonEmptyString(input.tool) ??
    getNonEmptyString(input.url) ??
    tcc.toolName
  );
}
