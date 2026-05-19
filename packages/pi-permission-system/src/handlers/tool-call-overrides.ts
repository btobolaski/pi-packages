import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WebAccessPermissionDecision } from "#src/authority/permission-dialog";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import type { PermissionConfigSaveContext } from "#src/config-store";
import type { DecisionReporter } from "#src/decision-reporter";
import type { PermissionSystemExtensionConfig } from "#src/extension-config";
import { runPreToolUseHooks } from "#src/hook-runner";
import type { HooksConfig } from "#src/hook-types";
import { shouldAllowLocalEdit } from "#src/local-edit";
import type { PathNormalizer } from "#src/path-normalizer";
import { PATH_BEARING_TOOLS } from "#src/path-surfaces";
import type { DebugReviewLogger } from "#src/session-logger";
import type { ToolPreviewFormatter } from "#src/tool-preview-formatter";
import type { PermissionCheckResult } from "#src/types";
import { toRecord } from "#src/value-guards";
import {
  extractDomainFromUrl,
  shouldAllowFetchForDomain,
  shouldAllowWebSearch,
} from "#src/web-access";
import type { ToolCallContext } from "./gates/types";

export interface ToolOverrideSession {
  readonly config: PermissionSystemExtensionConfig;
  getPathNormalizer(): PathNormalizer;
  getHooks(): HooksConfig | undefined;
  getAllowedFetchDomains(): ReadonlySet<string>;
  addAllowedFetchDomain(domain: string): void;
  persistAllowedFetchDomain(
    domain: string,
    ctx: PermissionConfigSaveContext,
  ): boolean;
}

export interface WebAccessPrompt {
  prompt(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
    domain: string,
  ): Promise<WebAccessPermissionDecision>;
}

export type ToolOverrideOutcome =
  | { action: "continue"; check: PermissionCheckResult }
  | { action: "allow" }
  | { action: "block"; reason: string };

export interface ToolCheckOverrides {
  apply(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
    policyCheck: PermissionCheckResult,
    formatter: ToolPreviewFormatter,
  ): Promise<ToolOverrideOutcome>;
}

/**
 * Applies explicit runtime overrides and PreToolUse hooks to the final
 * per-tool check, after every cross-cutting path/bash gate has passed.
 */
export class ToolCallOverrides implements ToolCheckOverrides {
  constructor(
    private readonly session: ToolOverrideSession,
    private readonly webPrompter: WebAccessPrompt,
    private readonly reporter: DecisionReporter,
    private readonly logger: DebugReviewLogger,
  ) {}

  async apply(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
    policyCheck: PermissionCheckResult,
    formatter: ToolPreviewFormatter,
  ): Promise<ToolOverrideOutcome> {
    const permissionLogContext = formatter.getPermissionLogContext(
      policyCheck,
      tcc.input,
      PATH_BEARING_TOOLS,
    );
    const override = this.applyConfigOverrides(
      tcc,
      policyCheck,
      permissionLogContext,
    );
    const hookOutcome = await this.applyHooks(
      tcc,
      ctx,
      policyCheck,
      override.check,
      override.active,
      permissionLogContext,
    );
    if (hookOutcome.action === "block") {
      return hookOutcome;
    }

    const effectiveCheck = hookOutcome.check;
    if (
      effectiveCheck.state === "allow" ||
      tcc.toolName !== "fetch_content" ||
      !this.session.config.allowWebAccess ||
      !ctx.hasUI
    ) {
      return { action: "continue", check: effectiveCheck };
    }

    const domain = extractDomainFromUrl(tcc.input);
    if (domain === null) {
      return { action: "continue", check: effectiveCheck };
    }
    return await this.promptForDomain(
      tcc,
      ctx,
      effectiveCheck,
      domain,
      permissionLogContext,
    );
  }

  private applyConfigOverrides(
    tcc: ToolCallContext,
    initialCheck: PermissionCheckResult,
    permissionLogContext: Record<string, unknown>,
  ): { check: PermissionCheckResult; active: boolean } {
    const config = this.session.config;
    let check = initialCheck;
    let active = false;

    if (
      check.state !== "allow" &&
      shouldAllowLocalEdit(
        tcc.toolName,
        tcc.input,
        this.session.getPathNormalizer(),
        config,
      )
    ) {
      const input = toRecord(tcc.input);
      this.logger.debug("allow_local_edit.override", {
        toolName: tcc.toolName,
        originalState: check.state,
        filePath: input.path ?? null,
        cwd: tcc.cwd,
      });
      this.reporter.writeReviewLog("permission_request.local_edit_allowed", {
        source: "tool_call",
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        agentName: tcc.agentName,
        ...permissionLogContext,
        resolution: "allow_local_edits",
      });
      check = { ...check, state: "allow" };
      active = true;
    }

    if (check.state !== "allow" && shouldAllowWebSearch(tcc.toolName, config)) {
      this.logger.debug("allow_web_access.override", {
        toolName: tcc.toolName,
        originalState: check.state,
      });
      this.reporter.writeReviewLog("permission_request.web_access_allowed", {
        source: "tool_call",
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        agentName: tcc.agentName,
        ...permissionLogContext,
        resolution: "allow_web_access",
      });
      check = { ...check, state: "allow" };
      active = true;
    }

    if (
      check.state !== "allow" &&
      shouldAllowFetchForDomain(
        tcc.toolName,
        tcc.input,
        config,
        this.session.getAllowedFetchDomains(),
      )
    ) {
      const domain = extractDomainFromUrl(tcc.input);
      this.logger.debug("allow_web_access.domain_override", {
        toolName: tcc.toolName,
        originalState: check.state,
        domain,
      });
      this.reporter.writeReviewLog(
        "permission_request.web_access_domain_allowed",
        {
          source: "tool_call",
          toolCallId: tcc.toolCallId,
          toolName: tcc.toolName,
          agentName: tcc.agentName,
          domain,
          ...permissionLogContext,
          resolution: "allow_web_access_domain",
        },
      );
      check = { ...check, state: "allow" };
      active = true;
    }

    return { check, active };
  }

  private async applyHooks(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
    policyCheck: PermissionCheckResult,
    effectiveCheck: PermissionCheckResult,
    overrideActive: boolean,
    permissionLogContext: Record<string, unknown>,
  ): Promise<
    | { action: "continue"; check: PermissionCheckResult }
    | { action: "block"; reason: string }
  > {
    const matchers = this.session.getHooks()?.PreToolUse;
    if (!matchers || matchers.length === 0) {
      return { action: "continue", check: effectiveCheck };
    }

    const hookDecision = await runPreToolUseHooks(
      matchers,
      tcc.toolName,
      tcc.input,
      {
        session_id: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        permission_mode: this.session.config.yoloMode ? "yolo" : "default",
        transcript_path: ctx.sessionManager.getSessionDir() || "",
      },
      tcc.toolCallId,
    );
    if (hookDecision.decision === "defer") {
      return { action: "continue", check: effectiveCheck };
    }

    this.logger.debug("hook.pretooluse_result", {
      toolName: tcc.toolName,
      policyState: policyCheck.state,
      effectiveState: effectiveCheck.state,
      hookDecision: hookDecision.decision,
      hookReasons: hookDecision.reasons,
    });
    if (hookDecision.updatedInput !== undefined) {
      this.logger.debug("hook.updated_input_not_supported", {
        toolName: tcc.toolName,
        updatedInput: hookDecision.updatedInput,
      });
    }
    if (hookDecision.additionalContext !== undefined) {
      this.logger.debug("hook.additional_context_not_supported", {
        toolName: tcc.toolName,
        additionalContext: hookDecision.additionalContext,
      });
    }

    if (hookDecision.decision === "deny") {
      const reason =
        hookDecision.reasons.length > 0
          ? hookDecision.reasons.join("; ")
          : "Blocked by PreToolUse hook";
      this.reporter.writeReviewLog("permission_request.blocked", {
        source: "pretooluse_hook",
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        agentName: tcc.agentName,
        ...permissionLogContext,
        resolution: "hook_denied",
        hookReasons: hookDecision.reasons,
      });
      return { action: "block", reason };
    }
    if (hookDecision.decision === "allow") {
      return {
        action: "continue",
        check: { ...effectiveCheck, state: "allow" },
      };
    }
    if (!overrideActive) {
      return {
        action: "continue",
        check: { ...effectiveCheck, state: "ask" },
      };
    }
    return { action: "continue", check: effectiveCheck };
  }

  private async promptForDomain(
    tcc: ToolCallContext,
    ctx: ExtensionContext,
    check: PermissionCheckResult,
    domain: string,
    permissionLogContext: Record<string, unknown>,
  ): Promise<ToolOverrideOutcome> {
    const decision = await this.webPrompter.prompt(
      ctx,
      {
        requestId: tcc.toolCallId || `web-${Date.now()}`,
        source: "tool_call",
        agentName: tcc.agentName,
        message: `Allow fetch_content to access ${domain}?`,
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        toolInputPreview:
          typeof permissionLogContext.toolInputPreview === "string"
            ? permissionLogContext.toolInputPreview
            : undefined,
      },
      domain,
    );

    if (decision.approved) {
      this.rememberApprovedDomain(
        tcc,
        ctx,
        domain,
        decision.domainAction,
        permissionLogContext,
      );
      this.reporter.emitDecision({
        surface: tcc.toolName,
        value: domain,
        result: "allow",
        resolution: "user_approved",
        origin: check.origin,
        agentName: tcc.agentName,
        matchedPattern: check.matchedPattern ?? null,
      });
      return { action: "allow" };
    }

    this.reporter.emitDecision({
      surface: tcc.toolName,
      value: domain,
      result: "deny",
      resolution: "user_denied",
      origin: check.origin,
      agentName: tcc.agentName,
      matchedPattern: check.matchedPattern ?? null,
    });
    const reason = decision.denialReason
      ? `User denied fetch_content for ${domain}: ${decision.denialReason}`
      : `User denied fetch_content for ${domain}.`;
    return { action: "block", reason };
  }

  private rememberApprovedDomain(
    tcc: ToolCallContext,
    ctx: PermissionConfigSaveContext,
    domain: string,
    action: WebAccessPermissionDecision["domainAction"],
    permissionLogContext: Record<string, unknown>,
  ): void {
    if (action === "allow_persist") {
      if (this.session.persistAllowedFetchDomain(domain, ctx)) {
        this.logger.debug("web_access.domain_persisted", {
          domain,
          toolCallId: tcc.toolCallId,
        });
        this.reporter.writeReviewLog("web_access.domain_persisted", {
          source: "tool_call",
          toolCallId: tcc.toolCallId,
          toolName: tcc.toolName,
          agentName: tcc.agentName,
          domain,
          ...permissionLogContext,
        });
        return;
      }
      this.session.addAllowedFetchDomain(domain);
      this.reporter.writeReviewLog("web_access.domain_persist_failed", {
        source: "tool_call",
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        agentName: tcc.agentName,
        domain,
        ...permissionLogContext,
      });
      return;
    }

    if (action === "allow_session") {
      this.session.addAllowedFetchDomain(domain);
      this.reporter.writeReviewLog("web_access.domain_session_allowed", {
        source: "tool_call",
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        agentName: tcc.agentName,
        domain,
        ...permissionLogContext,
      });
    }
  }
}
