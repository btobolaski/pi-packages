import type {
  ExtensionContext,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { getNonEmptyString, toRecord } from "#src/common";
import { runPreToolUseHooks } from "#src/hook-runner";
import type { HookExecutionContext } from "#src/hook-types";
import { shouldAllowLocalEdit } from "#src/local-edit";
import { PATH_BEARING_TOOLS } from "#src/path-utils";
import {
  emitDecisionEvent,
  type PermissionEventBus,
} from "#src/permission-events";
import { applyPermissionGate } from "#src/permission-gate";
import type { PromptPermissionDetails } from "#src/permission-prompter";
import {
  formatMissingToolNameReason,
  formatSkillAskPrompt,
  formatUnknownToolReason,
} from "#src/permission-prompts";
import type { PermissionSession } from "#src/permission-session";
import type { ToolInputFormatterLookup } from "#src/tool-input-formatter-registry";
import {
  resolveToolPreviewLimits,
  ToolPreviewFormatter,
} from "#src/tool-preview-formatter";
import {
  checkRequestedToolRegistration,
  getToolNameFromValue,
  type ToolRegistry,
} from "#src/tool-registry";
import type { PermissionCheckResult } from "#src/types";
import {
  extractDomainFromUrl,
  shouldAllowFetchForDomain,
  shouldAllowWebSearch,
} from "#src/web-access";
import { shouldAutoApprovePermissionState } from "#src/yolo-mode";
import { resolveBashCommandCheck } from "./gates/bash-command";
import { describeBashExternalDirectoryGate } from "./gates/bash-external-directory";
import { describeBashPathGate } from "./gates/bash-path";
import { BashProgram } from "./gates/bash-program";
import type { GateResult, GateRunnerDeps } from "./gates/descriptor";
import { isGateBypass } from "./gates/descriptor";
import { describeExternalDirectoryGate } from "./gates/external-directory";
import { describePathGate } from "./gates/path";
import { runGateCheck } from "./gates/runner";
import { describeSkillReadGate } from "./gates/skill-read";
import { describeToolGate } from "./gates/tool";
import type { ToolCallContext } from "./gates/types";

/** Minimal subset of InputEvent used by handleInput. */
interface InputPayload {
  text: string;
}

/**
 * Handles permission gate events: tool_call and input.
 *
 * Constructor deps:
 * - `session` — encapsulates all mutable session state and permission operations
 * - `events` — event bus for emitting permissions:decision broadcasts
 * - `toolRegistry` — Pi tool API subset (getAll + setActive)
 */
export class PermissionGateHandler {
  constructor(
    private readonly session: PermissionSession,
    private readonly events: PermissionEventBus,
    private readonly toolRegistry: ToolRegistry,
    private readonly customFormatters?: ToolInputFormatterLookup,
  ) {}

  async handleToolCall(
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<{ block?: true; reason?: string }> {
    this.session.activate(ctx);

    const validation = validateRequestedTool(event, this.toolRegistry.getAll());
    if (validation.status === "block") {
      return { block: true, reason: validation.reason };
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
    };

    // Parse the bash command exactly once per tool_call; the three bash gates
    // share this single BashProgram instead of each re-parsing (#308).
    const command = getNonEmptyString(toRecord(tcc.input).command);
    const bashProgram =
      tcc.toolName === "bash" && command
        ? await BashProgram.parse(command)
        : null;

    // ── Shared gate adapter closures ─────────────────────────────────────
    const canConfirm = () => this.session.canPrompt(ctx);
    const promptPermission = (details: PromptPermissionDetails) =>
      this.session.prompt(ctx, details);
    const emitDecision: GateRunnerDeps["emitDecision"] = (e) =>
      emitDecisionEvent(this.events, e);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- logger.review is a plain function closure; no this-binding issue
    const writeReviewLog = this.session.logger.review;
    const checkPermission: GateRunnerDeps["checkPermission"] = (
      surface,
      input,
      agent,
      sessionRules,
    ) => this.session.checkPermission(surface, input, agent, sessionRules);
    const getSessionRuleset = () => this.session.getSessionRuleset();
    const recordSessionApproval: GateRunnerDeps["recordSessionApproval"] = (
      approval,
    ) => this.session.recordSessionApproval(approval);

    // ── Shared runner deps (built once, reused for all gates) ────────────
    const runnerDeps: GateRunnerDeps = {
      checkPermission,
      getSessionRuleset,
      recordSessionApproval,
      writeReviewLog,
      emitDecision,
      canConfirm,
      promptPermission,
    };

    // ── Unified gate executor ─────────────────────────────────────────────
    // Handles the bypass log/emit branch, calls runGateCheck for descriptors,
    // and returns a block result or undefined (allow / no-op).
    const runGate = async (
      gate: GateResult,
    ): Promise<{ block: true; reason: string } | undefined> => {
      if (!gate) {
        return undefined;
      }
      if (isGateBypass(gate)) {
        if (gate.log) {
          writeReviewLog(gate.log.event, gate.log.details);
        }
        if (gate.decision) {
          emitDecision(gate.decision);
        }
        return undefined;
      }
      const result = await runGateCheck(
        gate,
        tcc.agentName,
        tcc.toolCallId,
        runnerDeps,
      );
      return result.action === "block"
        ? { block: true, reason: result.reason }
        : undefined;
    };

    const formatter = new ToolPreviewFormatter(
      resolveToolPreviewLimits(this.session.config),
      this.customFormatters,
    );

    // ── Ordered gate pipeline ─────────────────────────────────────────────
    // infraDirs is computed once, outside the pipeline, exactly as before.
    const infraDirs = [
      ...this.session.getInfrastructureDirs(),
      ...this.session.getInfrastructureReadPaths(),
    ];

    const gateProducers: Array<() => GateResult | Promise<GateResult>> = [
      () =>
        describeSkillReadGate(tcc, () => this.session.getActiveSkillEntries()),
      () => describePathGate(tcc, checkPermission, getSessionRuleset),
      () => describeExternalDirectoryGate(tcc, infraDirs),
      () =>
        describeBashExternalDirectoryGate(
          tcc,
          bashProgram,
          checkPermission,
          getSessionRuleset,
        ),
      () =>
        describeBashPathGate(
          tcc,
          bashProgram,
          checkPermission,
          getSessionRuleset,
        ),
    ];

    for (const produce of gateProducers) {
      const blocked = await runGate(await produce());
      if (blocked) {
        return blocked;
      }
    }

    // Bash commands may chain several sub-commands (`a && b`, `a | b`, …);
    // evaluate each unit from the shared parse on the bash surface and select
    // the most restrictive. Other tools evaluate their single input directly.
    const toolCheck =
      tcc.toolName === "bash" && bashProgram
        ? resolveBashCommandCheck(
            command ?? "",
            bashProgram.commands(),
            tcc.agentName ?? undefined,
            getSessionRuleset(),
            checkPermission,
          )
        : checkPermission(
            tcc.toolName,
            tcc.input,
            tcc.agentName ?? undefined,
            getSessionRuleset(),
          );

    const overrideOutcome = this.applyConfigOverrides(
      tcc,
      ctx,
      toolCheck,
      runnerDeps,
      formatter,
    );
    let effectiveCheck = overrideOutcome.check;

    const hookOutcome = await this.applyPreToolUseHooks(
      tcc,
      ctx,
      toolCheck,
      effectiveCheck,
      overrideOutcome.overrideActive,
      runnerDeps,
      formatter,
    );
    if (hookOutcome.kind === "handled") {
      return hookOutcome.result;
    }
    effectiveCheck = hookOutcome.check;

    // The per-domain dialog runs after hooks so hooks can veto the request.
    const dialogOutcome = await this.runFetchContentDialogIfNeeded(
      tcc,
      ctx,
      effectiveCheck,
      runnerDeps,
      formatter,
    );
    if (dialogOutcome.kind === "handled") {
      return dialogOutcome.result;
    }

    const toolDescriptor = describeToolGate(tcc, effectiveCheck, formatter);
    toolDescriptor.preCheck = effectiveCheck;
    const blocked = await runGate(toolDescriptor);
    if (blocked) {
      return blocked;
    }

    return {};
  }

  /**
   * Apply `allowLocalEdits` and `allowWebAccess` config overrides.
   *
   * Each override may flip `effectiveCheck.state` from a non-allow value
   * (`ask` or `deny`) to `"allow"` and sets `overrideActive` so the hook
   * stage knows not to re-introduce an `"ask"` prompt.
   */
  private applyConfigOverrides(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
    initialCheck: PermissionCheckResult,
    runnerDeps: GateRunnerDeps,
    formatter: ToolPreviewFormatter,
  ): {
    check: PermissionCheckResult;
    overrideActive: boolean;
  } {
    const { session } = this;
    const config = session.config;
    const permissionLogContext = formatter.getPermissionLogContext(
      initialCheck,
      tcc.input,
      PATH_BEARING_TOOLS,
    );
    const writeReviewLog: GateRunnerDeps["writeReviewLog"] = (event, details) =>
      runnerDeps.writeReviewLog(event, details);
    const writeDebugLog = (event: string, details: Record<string, unknown>) =>
      session.logger.debug(event, details);

    let effectiveCheck = initialCheck;
    let overrideActive = false;

    if (
      effectiveCheck.state !== "allow" &&
      shouldAllowLocalEdit(tcc.toolName, tcc.input, ctx.cwd, config)
    ) {
      const inputRecord = toRecord(tcc.input);
      writeDebugLog("allow_local_edit.override", {
        toolName: tcc.toolName,
        originalState: effectiveCheck.state,
        filePath: inputRecord.file_path ?? inputRecord.path ?? null,
        cwd: ctx.cwd,
      });
      writeReviewLog("permission_request.local_edit_allowed", {
        source: "tool_call",
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        agentName: tcc.agentName,
        ...permissionLogContext,
        resolution: "allow_local_edits",
      });
      effectiveCheck = { ...effectiveCheck, state: "allow" };
      overrideActive = true;
    }

    if (
      effectiveCheck.state !== "allow" &&
      shouldAllowWebSearch(tcc.toolName, config)
    ) {
      writeDebugLog("allow_web_access.override", {
        toolName: tcc.toolName,
        originalState: effectiveCheck.state,
      });
      writeReviewLog("permission_request.web_access_allowed", {
        source: "tool_call",
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        agentName: tcc.agentName,
        ...permissionLogContext,
        resolution: "allow_web_access",
      });
      effectiveCheck = { ...effectiveCheck, state: "allow" };
      overrideActive = true;
    }

    if (
      effectiveCheck.state !== "allow" &&
      shouldAllowFetchForDomain(
        tcc.toolName,
        tcc.input,
        config,
        session.getAllowedFetchDomains(),
      )
    ) {
      const domain = extractDomainFromUrl(tcc.input);
      writeDebugLog("allow_web_access.domain_override", {
        toolName: tcc.toolName,
        originalState: effectiveCheck.state,
        domain,
      });
      writeReviewLog("permission_request.web_access_domain_allowed", {
        source: "tool_call",
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        agentName: tcc.agentName,
        domain,
        ...permissionLogContext,
        resolution: "allow_web_access_domain",
      });
      effectiveCheck = { ...effectiveCheck, state: "allow" };
      overrideActive = true;
    }

    return { check: effectiveCheck, overrideActive };
  }

  /**
   * Run the per-domain `fetch_content` dialog when the call still needs
   * user input, `allowWebAccess` is on, a UI is available, yolo is off, and
   * the URL parses to a domain. Runs AFTER PreToolUse hooks so a hook can
   * deny/ask before the user is prompted.
   */
  private async runFetchContentDialogIfNeeded(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
    effectiveCheck: PermissionCheckResult,
    runnerDeps: GateRunnerDeps,
    formatter: ToolPreviewFormatter,
  ): Promise<
    | { kind: "continue" }
    | { kind: "handled"; result: { block?: true; reason?: string } }
  > {
    const config = this.session.config;
    if (
      effectiveCheck.state === "allow" ||
      tcc.toolName !== "fetch_content" ||
      !config.allowWebAccess ||
      !ctx.hasUI ||
      shouldAutoApprovePermissionState("ask", config)
    ) {
      return { kind: "continue" };
    }
    const domain = extractDomainFromUrl(tcc.input);
    if (!domain) {
      return { kind: "continue" };
    }
    const permissionLogContext = formatter.getPermissionLogContext(
      effectiveCheck,
      tcc.input,
      PATH_BEARING_TOOLS,
    );
    const handled = await this.runFetchContentWebDialog(
      tcc,
      ctx,
      effectiveCheck,
      domain,
      permissionLogContext,
      runnerDeps,
    );
    if (handled) {
      return { kind: "handled", result: handled };
    }
    return { kind: "continue" };
  }

  /**
   * Run configured PreToolUse hooks (Claude Code-compatible) and fold their
   * merged decision into `effectiveCheck`. Hooks can:
   *
   *   - `deny`  → return a block result with the hooks' joined reasons.
   *   - `allow` → force the effective state to `"allow"`.
   *   - `ask`   → force the effective state to `"ask"`, UNLESS a config
   *     override (`allowLocalEdits` / `allowWebAccess`) already forced allow.
   *   - `defer` → leave the effective check unchanged.
   *
   * Pi's tool-call hook return surface only supports `{ block, reason }`, so
   * `updatedInput` and `additionalContext` from hooks are logged for
   * debugging but cannot be propagated to the agent runtime.
   */
  private async applyPreToolUseHooks(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
    policyCheck: PermissionCheckResult,
    effectiveCheck: PermissionCheckResult,
    overrideActive: boolean,
    runnerDeps: GateRunnerDeps,
    formatter: ToolPreviewFormatter,
  ): Promise<
    | { kind: "continue"; check: PermissionCheckResult }
    | { kind: "handled"; result: { block?: true; reason?: string } }
  > {
    const { session } = this;
    const hooksConfig = session.getHooks();
    const matchers = hooksConfig?.PreToolUse;
    if (!matchers || matchers.length === 0) {
      return { kind: "continue", check: effectiveCheck };
    }

    const writeDebugLog = (event: string, details: Record<string, unknown>) =>
      session.logger.debug(event, details);
    const writeReviewLog: GateRunnerDeps["writeReviewLog"] = (event, details) =>
      runnerDeps.writeReviewLog(event, details);
    const config = session.config;

    const hookContext: HookExecutionContext = {
      session_id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      permission_mode: config.yoloMode ? "yolo" : "default",
      transcript_path: ctx.sessionManager.getSessionDir() || "",
    };

    const hookDecision = await runPreToolUseHooks(
      matchers,
      tcc.toolName,
      tcc.input,
      hookContext,
      tcc.toolCallId,
    );

    if (hookDecision.decision === "defer") {
      return { kind: "continue", check: effectiveCheck };
    }

    writeDebugLog("hook.pretooluse_result", {
      toolName: tcc.toolName,
      policyState: policyCheck.state,
      effectiveState: effectiveCheck.state,
      hookDecision: hookDecision.decision,
      hookReasons: hookDecision.reasons,
    });

    if (hookDecision.updatedInput !== undefined) {
      writeDebugLog("hook.updated_input_not_supported", {
        toolName: tcc.toolName,
        updatedInput: hookDecision.updatedInput,
      });
    }

    if (hookDecision.additionalContext !== undefined) {
      writeDebugLog("hook.additional_context_not_supported", {
        toolName: tcc.toolName,
        additionalContext: hookDecision.additionalContext,
      });
    }

    if (hookDecision.decision === "deny") {
      const permissionLogContext = formatter.getPermissionLogContext(
        policyCheck,
        tcc.input,
        PATH_BEARING_TOOLS,
      );
      const reason =
        hookDecision.reasons.length > 0
          ? hookDecision.reasons.join("; ")
          : "Blocked by PreToolUse hook";
      writeReviewLog("permission_request.blocked", {
        source: "pretooluse_hook",
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        agentName: tcc.agentName,
        ...permissionLogContext,
        resolution: "hook_denied",
        hookReasons: hookDecision.reasons,
      });
      return { kind: "handled", result: { block: true, reason } };
    }

    if (hookDecision.decision === "allow") {
      return {
        kind: "continue",
        check: { ...effectiveCheck, state: "allow" },
      };
    }

    // decision === "ask": only re-introduce a prompt when no override has
    // already forced an allow — otherwise a hook "ask" would undo the
    // override's intent.
    if (!overrideActive) {
      return {
        kind: "continue",
        check: { ...effectiveCheck, state: "ask" },
      };
    }
    return { kind: "continue", check: effectiveCheck };
  }

  /**
   * Run the per-domain `fetch_content` dialog. Returns the gate handler's
   * outgoing block/allow result, or null to fall through to the standard
   * tool gate when no dialog could be presented.
   */
  private async runFetchContentWebDialog(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
    check: PermissionCheckResult,
    domain: string,
    permissionLogContext: Record<string, unknown>,
    runnerDeps: GateRunnerDeps,
  ): Promise<{ block?: true; reason?: string } | null> {
    const { session } = this;
    const message = `Allow fetch_content to access ${domain}?`;
    const decision = await session.promptWebAccess(
      ctx,
      {
        requestId: tcc.toolCallId || session.createPermissionRequestId("web"),
        source: "tool_call",
        agentName: tcc.agentName,
        message,
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
      },
      domain,
    );

    // NOTE: `permission_request.approved` / `permission_request.denied`
    // review entries are written by `PermissionPrompter.promptWebAccess` so
    // every prompt has exactly one final-decision audit row. The handler
    // owns the additional `web_access.domain_*` audit rows (which carry the
    // domain + permissionLogContext) and the `permissions:decision` event.
    if (decision.approved) {
      if (decision.domainAction === "allow_persist") {
        if ("ui" in ctx) {
          const result = session.persistAllowedFetchDomain(
            domain,
            ctx as Parameters<typeof session.persistAllowedFetchDomain>[1],
          );
          if (result.persisted) {
            session.logger.debug("web_access.domain_persisted", {
              domain,
              toolCallId: tcc.toolCallId,
            });
            runnerDeps.writeReviewLog("web_access.domain_persisted", {
              source: "tool_call",
              toolCallId: tcc.toolCallId,
              toolName: tcc.toolName,
              agentName: tcc.agentName,
              domain,
              ...permissionLogContext,
            });
          } else {
            // Save failed (the runtime already notified the UI). Fall back
            // to a session-only allow so the immediate request still works,
            // but log a distinct event so audits can see the downgrade.
            session.addAllowedFetchDomain(domain);
            runnerDeps.writeReviewLog("web_access.domain_persist_failed", {
              source: "tool_call",
              toolCallId: tcc.toolCallId,
              toolName: tcc.toolName,
              agentName: tcc.agentName,
              domain,
              ...permissionLogContext,
            });
          }
        } else {
          // No UI context to persist through — degrade to session-only.
          session.addAllowedFetchDomain(domain);
          runnerDeps.writeReviewLog("web_access.domain_session_allowed", {
            source: "tool_call",
            toolCallId: tcc.toolCallId,
            toolName: tcc.toolName,
            agentName: tcc.agentName,
            domain,
            ...permissionLogContext,
          });
        }
      } else if (decision.domainAction === "allow_session") {
        session.addAllowedFetchDomain(domain);
        runnerDeps.writeReviewLog("web_access.domain_session_allowed", {
          source: "tool_call",
          toolCallId: tcc.toolCallId,
          toolName: tcc.toolName,
          agentName: tcc.agentName,
          domain,
          ...permissionLogContext,
        });
      }

      runnerDeps.emitDecision({
        surface: tcc.toolName,
        value: domain,
        result: "allow",
        resolution: decision.autoApproved ? "auto_approved" : "user_approved",
        origin: check.origin,
        agentName: tcc.agentName ?? null,
        matchedPattern: check.matchedPattern ?? null,
      });
      return {};
    }

    runnerDeps.emitDecision({
      surface: tcc.toolName,
      value: domain,
      result: "deny",
      resolution: "user_denied",
      origin: check.origin,
      agentName: tcc.agentName ?? null,
      matchedPattern: check.matchedPattern ?? null,
    });

    const reason =
      decision.denialReason && decision.denialReason.trim().length > 0
        ? `User denied fetch_content for ${domain}: ${decision.denialReason}`
        : `User denied fetch_content for ${domain}.`;
    return { block: true, reason };
  }

  async handleInput(
    event: InputPayload,
    ctx: ExtensionContext,
  ): Promise<InputEventResult> {
    this.session.activate(ctx);

    const skillName = extractSkillNameFromInput(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    const agentName = this.session.resolveAgentName(ctx);
    const check = this.session.checkPermission(
      "skill",
      { name: skillName },
      agentName ?? undefined,
    );

    if (check.state === "deny" && ctx.hasUI) {
      const notifyMessage = agentName
        ? `Skill '${skillName}' is not permitted for agent '${agentName}'.`
        : `Skill '${skillName}' is not permitted by the current skill policy.`;
      ctx.ui.notify(notifyMessage, "warning");
    }

    const skillInputMessage = formatSkillAskPrompt(
      skillName,
      agentName ?? undefined,
    );
    const skillInputCanConfirm = this.session.canPrompt(ctx);
    let skillInputAutoApproved = false;
    const skillInputGate = await applyPermissionGate({
      state: check.state,
      canConfirm: skillInputCanConfirm,
      promptForApproval: async () => {
        const decision = await this.session.prompt(ctx, {
          requestId: this.session.createPermissionRequestId("skill-input"),
          source: "skill_input",
          agentName,
          message: skillInputMessage,
          skillName,
        });
        skillInputAutoApproved = decision.autoApproved === true;
        return decision;
      },
      // eslint-disable-next-line @typescript-eslint/unbound-method -- logger.review is a plain function closure; no this-binding issue
      writeLog: this.session.logger.review,
      logContext: {
        source: "skill_input",
        skillName,
        agentName,
        message: skillInputMessage,
      },
      messages: {
        denyReason: skillInputMessage,
        unavailableReason:
          "Skill requires approval, but no interactive UI is available.",
        userDeniedReason: () => "User denied skill.",
      },
    });

    emitDecisionEvent(this.events, {
      surface: "skill",
      value: skillName,
      result: skillInputGate.action === "allow" ? "allow" : "deny",
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive fallback; TypeScript narrows check.state before the ternary's else branch */
      resolution:
        check.state === "allow"
          ? "policy_allow"
          : check.state === "deny"
            ? "policy_deny"
            : skillInputGate.action === "allow"
              ? skillInputAutoApproved
                ? "auto_approved"
                : "user_approved"
              : skillInputCanConfirm
                ? "user_denied"
                : "confirmation_unavailable",
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ?? null normalises undefined to null for the log record
      origin: check.origin ?? null,
      agentName: agentName ?? null,
      matchedPattern: check.matchedPattern ?? null,
    });

    if (skillInputGate.action === "block") {
      return { action: "handled" };
    }

    return { action: "continue" };
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

/**
 * Parse a `/skill:<name>` prefix from user input.
 * Returns the skill name, or null if the text is not a skill invocation.
 */
export function extractSkillNameFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/skill:")) {
    return null;
  }

  const afterPrefix = trimmed.slice("/skill:".length);
  if (!afterPrefix) {
    return null;
  }

  const firstWhitespace = afterPrefix.search(/\s/);
  const skillName = (
    firstWhitespace === -1 ? afterPrefix : afterPrefix.slice(0, firstWhitespace)
  ).trim();
  return skillName || null;
}
