import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InteractivePromptQueue } from "#src/authority/interactive-prompt-queue";
import type {
  PermissionPromptDecision,
  RequestPermissionOptions,
} from "#src/authority/permission-dialog";
import {
  FORWARDED_PERMISSION_TIMEOUT_DECISION,
  ForwardedPermissionDeadlineExpiredError,
  type ForwardingDeadline,
  isForwardingDeadlineExpired,
} from "#src/authority/permission-forwarding";
import type {
  PermissionPromptUi,
  PromptPreferences,
  requestPermissionDecision,
} from "#src/authority/permission-prompt-component";
import { buildForwardedScopeLabels } from "#src/pattern-suggest";
import {
  emitUiPromptEvent,
  type PermissionEventBus,
} from "#src/permission-events";
import { buildUiPrompt } from "#src/permission-ui-prompt";
import type { TerminalAuthorizer } from "./authorizer";
import type { PromptPermissionDetails } from "./permission-prompter";

/** Dependencies required by {@link LocalUserAuthorizer}. */
export interface LocalUserAuthorizerDeps {
  /** The active session's UI surface (select/input plus the inline `custom` dialog). */
  ui: PermissionPromptUi;
  /** The session run mode; the dispatcher renders the inline dialog only in `"tui"`. */
  mode: ExtensionContext["mode"];
  /** Event bus used for the `permissions:ui_prompt` broadcast. */
  events: PermissionEventBus;
  /** Read live at prompt time so a settings-modal toggle takes effect on the next prompt. */
  getPromptPreferences: () => PromptPreferences;
  /** Serializes complete human prompt transactions. */
  promptQueue: InteractivePromptQueue;
  /** Injected for testability; production callers pass the real function. */
  requestPermissionDecision: typeof requestPermissionDecision;
  /** Marks only the lifetime of a real, locally served human prompt. */
  setPromptIndicator: (active: boolean) => Promise<void>;
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
export class LocalUserAuthorizer implements TerminalAuthorizer {
  constructor(private readonly deps: LocalUserAuthorizerDeps) {}

  async authorize(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    const { forwardingDeadline } = details;
    if (isForwardingDeadlineExpired(forwardingDeadline)) {
      return FORWARDED_PERMISSION_TIMEOUT_DECISION;
    }

    try {
      return await this.deps.promptQueue.run(async (signal) => {
        assertActive(forwardingDeadline, signal);
        const uiPrompt = buildUiPrompt(details);
        await this.deps.setPromptIndicator(true);
        try {
          assertActive(forwardingDeadline, signal);
          emitUiPromptEvent(this.deps.events, uiPrompt);
          const requestOptions = buildRequestOptions(details);
          const decision = await this.deps.requestPermissionDecision(
            {
              mode: this.deps.mode,
              ui: this.deps.ui,
              ...this.deps.getPromptPreferences(),
              signal,
            },
            details.forwarding
              ? "Permission Required (Subagent)"
              : "Permission Required",
            details.payload,
            forwardingDeadline
              ? {
                  ...(requestOptions ?? {}),
                  forwardingDeadline: {
                    ...forwardingDeadline,
                    signal,
                  },
                }
              : requestOptions,
          );
          assertActive(forwardingDeadline, signal);
          return decision;
        } finally {
          await this.deps.setPromptIndicator(false);
        }
      }, forwardingDeadline?.signal);
    } catch (error) {
      if (isForwardingDeadlineExpired(forwardingDeadline)) {
        return FORWARDED_PERMISSION_TIMEOUT_DECISION;
      }
      throw error;
    }
  }
}

function assertActive(
  deadline: ForwardingDeadline | undefined,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  if (isForwardingDeadlineExpired(deadline)) {
    throw new ForwardedPermissionDeadlineExpiredError();
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
