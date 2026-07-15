import type { InteractivePromptQueue } from "#src/authority/interactive-prompt-queue";
import type {
  PermissionDecisionUi,
  PermissionPromptDecision,
  RequestPermissionOptions,
  requestPermissionDecisionFromUi,
} from "#src/authority/permission-dialog";
import { buildForwardedScopeLabels } from "#src/pattern-suggest";
import {
  emitUiPromptEvent,
  type PermissionEventBus,
} from "#src/permission-events";
import { buildUiPrompt } from "#src/permission-ui-prompt";
import type { Authorizer } from "./authorizer";
import type { PromptPermissionDetails } from "./permission-prompter";

/** Dependencies required by {@link LocalUserAuthorizer}. */
export interface LocalUserAuthorizerDeps {
  /** The active session's UI surface. */
  ui: PermissionDecisionUi;
  /** Event bus used for the `permissions:ui_prompt` broadcast. */
  events: PermissionEventBus;
  /** Serializes complete local UI interactions. */
  queue: InteractivePromptQueue;
  /** Injected for testability; production callers pass the real function. */
  requestPermissionDecisionFromUi: typeof requestPermissionDecisionFromUi;
}

/**
 * Authorizer for a session with an active UI: prompt the human here.
 *
 * Emits the `permissions:ui_prompt` broadcast (moved here from
 * `PermissionPrompter`'s `ctx.hasUI` arm) before showing the dialog, so
 * observers know a decision is imminent. This is the single emit site: a
 * forwarded ask carries its provenance on `details.forwarding`, which this
 * class renders (populated `forwarding` context + "(Subagent)" title) so the
 * broadcast stays non-degraded (#292) without a second emission path.
 */
export class LocalUserAuthorizer implements Authorizer {
  constructor(private readonly deps: LocalUserAuthorizerDeps) {}

  authorize(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    return this.deps.queue.run((signal) => {
      const uiPrompt = buildUiPrompt(details);
      emitUiPromptEvent(this.deps.events, uiPrompt);
      return this.deps.requestPermissionDecisionFromUi(
        this.deps.ui,
        details.forwarding
          ? "Permission Required (Subagent)"
          : "Permission Required",
        details.message,
        buildRequestOptions(details),
        signal,
      );
    });
  }
}

/**
 * A forwarded ask carrying a session-approval suggestion offers the scope
 * choice (subagent vs whole session); any other ask keeps its single
 * "for this session" option (custom label when the gate supplied one).
 */
function buildRequestOptions(
  details: PromptPermissionDetails,
): RequestPermissionOptions | undefined {
  const pattern = details.sessionApproval?.patterns[0];
  if (details.forwarding && details.sessionApproval && pattern) {
    return {
      sessionScope: buildForwardedScopeLabels(
        details.forwarding.requesterAgentName,
        details.sessionApproval.surface,
        pattern,
      ),
    };
  }
  return details.sessionLabel
    ? { sessionLabel: details.sessionLabel }
    : undefined;
}
