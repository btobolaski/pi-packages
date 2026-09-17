import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatMissingToolNameReason,
  formatUnknownToolReason,
} from "#src/permission-prompts";
import type { PermissionSession } from "#src/permission-session";
import {
  checkRequestedToolRegistration,
  getToolNameFromValue,
  type ToolRegistry,
} from "#src/tool-registry";
import { toRecord } from "#src/value-guards";
import type { PreToolUseHookEvaluator } from "./gates/pre-tool-use-hook-gate";
import type { GateRunner } from "./gates/runner";
import type { ToolCallGatePipeline } from "./gates/tool-call-gate-pipeline";
import type { GateOutcome, ToolCallContext } from "./gates/types";

/**
 * Handles tool-call permission gates.
 *
 * Constructor deps:
 * - `session` — state/lifecycle owner: bind per-event context, resolve agent name
 * - `toolRegistry` — Pi tool API subset (getAll + setActive)
 * - `pipeline` — owns tool-call gate-producer assembly and the run loop
 * - `runner` — pre-built gate runner (constructed in the composition root)
 */
export class PermissionGateHandler {
  constructor(
    private readonly session: PermissionSession,
    private readonly toolRegistry: ToolRegistry,
    private readonly pipeline: ToolCallGatePipeline,
    private readonly runner: GateRunner,
    private readonly preToolUseHooks: PreToolUseHookEvaluator,
  ) {}

  async handleToolCall(
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<GateOutcome> {
    const originalSignal = ctx.signal;
    this.session.activate(ctx);
    if (!this.session.isPermissionReady())
      return { action: "block", reason: "Delegated permissions are not ready" };
    const signal = this.session.capturePermissionSignal(originalSignal);
    const lifetime = {
      signal,
      isActive: () => !signal.aborted && this.session.isPermissionReady(),
    };
    const cancelled = (): GateOutcome => ({
      action: "block",
      reason: this.session.isPermissionReady()
        ? "Permission request cancelled"
        : "Delegated permissions are no longer ready",
    });
    if (!lifetime.isActive()) return cancelled();

    const validation = validateRequestedTool(event, this.toolRegistry.getAll());
    if (validation.status === "block") {
      return { action: "block", reason: validation.reason };
    }
    const toolName = validation.toolName;

    const agentName = this.session.resolveAgentName(ctx);

    const input = getEventInput(event);
    const toolCallId =
      typeof (event as Record<string, unknown>).toolCallId === "string"
        ? ((event as Record<string, unknown>).toolCallId as string)
        : "";

    const tcc: ToolCallContext = {
      toolName,
      agentName,
      input,
      toolCallId,
      cwd: ctx.cwd,
      lifetime,
    };

    const hookOutcome = await this.preToolUseHooks.evaluate(tcc, ctx);
    if (!lifetime.isActive()) return cancelled();
    if (hookOutcome.action !== "continue") {
      return hookOutcome;
    }
    const result = await this.pipeline.evaluate(tcc, this.runner);
    return lifetime.isActive() ? result : cancelled();
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/** Discriminated result of validating a tool-call event's name and registration. */
export type RequestedToolValidation =
  | { status: "ok"; toolName: string }
  | { status: "block"; reason: string };

/**
 * Validate the tool name from a raw event against the registered tool list.
 *
 * Composes `getToolNameFromValue` + `checkRequestedToolRegistration` + the
 * two reason formatters and returns a discriminated result so `handleToolCall`
 * reads as a straight validate → proceed path without nested early-returns.
 *
 * Returns the **raw** tool name (not the normalised form) so that
 * `ToolCallContext.toolName` stays identical to the pre-extraction behaviour.
 */
export function validateRequestedTool(
  event: unknown,
  availableTools: readonly unknown[],
): RequestedToolValidation {
  const toolName = getToolNameFromValue(event);
  if (!toolName) {
    return { status: "block", reason: formatMissingToolNameReason() };
  }
  const check = checkRequestedToolRegistration(toolName, availableTools);
  if (check.status === "missing-tool-name") {
    return { status: "block", reason: formatMissingToolNameReason() };
  }
  if (check.status === "unregistered") {
    return {
      status: "block",
      reason: formatUnknownToolReason(
        check.requestedToolName,
        check.availableToolNames,
      ),
    };
  }
  return { status: "ok", toolName };
}

/**
 * Extract the tool input from an event, checking both `input` and `arguments`
 * fields (different Pi SDK versions use different names).
 */
// pi-lens-ignore: no-unknown-returns -- arbitrary plugin input is validated by its tool-specific gate.
export function getEventInput(event: unknown): unknown {
  const record = toRecord(event);

  if (record.input !== undefined) {
    return record.input;
  }

  if (record.arguments !== undefined) {
    return record.arguments;
  }

  return {};
}
