import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { DecisionSource } from "#src/authority/decision-source";
import {
  ForwardedPermissionDeadlineExpiredError,
  type ForwardingDeadline,
  isForwardingDeadlineExpired,
} from "#src/authority/permission-forwarding";

export type PermissionDecisionState =
  | "approved"
  | "approved_for_session"
  | "approved_for_serving_session"
  | "denied"
  | "denied_with_reason";

export type PermissionPromptDecision = {
  approved: boolean;
  state: PermissionDecisionState;
  denialReason?: string;
  /**
   * True when the decision was made automatically by yolo mode rather than
   * by an interactive user prompt. Used by handlers to emit "auto_approved"
   * rather than "user_approved" in the permissions:decision broadcast.
   */
  autoApproved?: true;
  /**
   * True when no human ruled on this ask: for example, no live authority was
   * reachable, forwarding failed before delivery, or a forwarded request's
   * deadline expired before an answer. Consumed by deriveResolution (the
   * decision-event resolution), the gate (block reason), and
   * PermissionPrompter (review-entry resolution) to emit
   * "confirmation_unavailable" rather than a plain user denial — a user who
   * never completed a decision denied nothing (#719).
   */
  confirmationUnavailable?: true;
  /** True only when a forwarded request reached its shared deadline. */
  forwardingTimedOut?: true;
  /**
   * What decided this request, stamped by the site that decided it.
   *
   * Required: every decision names its decider, and the type is what
   * guarantees it rather than a convention each producer has to remember — the
   * same discipline `PromptPermissionDetails.payload` carries (#726).
   */
  decidedBy: DecisionSource;
};

/**
 * A decision before its decider is known.
 *
 * The inner producers — the dialog's decision model, the `select`/`input`
 * fallback, the verdict mapper — state the outcome; which decider to attribute
 * it to is settled one layer up, at the site that chose the producer. The same
 * shape `GateBypass.decision` uses for the request id: a producer emits only
 * what it knows.
 */
export type UnattributedDecision = Omit<PermissionPromptDecision, "decidedBy">;

export interface PermissionDecisionUi {
  select(
    title: string,
    options: string[],
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;
  input(
    title: string,
    placeholder?: string,
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;
}

const APPROVE_OPTION = "Yes";
const APPROVE_FOR_SESSION_OPTION = "Yes, for this session";
const DENY_OPTION = "No";
const DENY_WITH_REASON_OPTION = "No, provide reason";

export function normalizePermissionDenialReason(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createDeniedPermissionDecision(
  denialReason?: string,
): UnattributedDecision {
  const normalizedReason = normalizePermissionDenialReason(denialReason);
  return normalizedReason
    ? {
        approved: false,
        state: "denied_with_reason",
        denialReason: normalizedReason,
      }
    : {
        approved: false,
        state: "denied",
      };
}

/** Deny because no live authority completed the permission request. */
export function createUnavailablePermissionDecision(
  reason: string,
): PermissionPromptDecision {
  return {
    approved: false,
    state: "denied",
    confirmationUnavailable: true,
    denialReason: reason,
    decidedBy: { kind: "unavailable", reason },
  };
}

export function isPermissionDecisionState(
  value: unknown,
): value is PermissionDecisionState {
  return (
    value === "approved" ||
    value === "approved_for_session" ||
    value === "approved_for_serving_session" ||
    value === "denied" ||
    value === "denied_with_reason"
  );
}

export interface RequestPermissionOptions {
  /**
   * Runtime-only deadline control for a forwarded interaction.
   *
   * When a prompt view also carries a signal, both fields must carry the same
   * session/request-combined signal. `LocalUserAuthorizer` establishes that
   * alias after queue admission so session teardown still closes the dialog.
   */
  forwardingDeadline?: ForwardingDeadline;
  /** Override the "for this session" option label (e.g. to show the suggested pattern). */
  sessionLabel?: string;
  /**
   * Forwarded asks only: when set, choosing the "for this session" option opens
   * a second select asking whether the grant applies to the requesting subagent
   * only (the least-privilege default) or the whole serving session.
   */
  sessionScope?: {
    subagentLabel: string;
    servingSessionLabel: string;
  };
}

export async function requestPermissionDecisionFromUi(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
  options?: RequestPermissionOptions,
): Promise<UnattributedDecision> {
  const sessionOption = options?.sessionLabel ?? APPROVE_FOR_SESSION_OPTION;
  const decisionOptions = [
    APPROVE_OPTION,
    sessionOption,
    DENY_OPTION,
    DENY_WITH_REASON_OPTION,
  ] as const;

  const deadline = options?.forwardingDeadline;
  const selected = await ui.select(
    `${title}\n${message}`,
    [...decisionOptions],
    deadline ? dialogOptions(deadline) : undefined,
  );
  assertDeadlineActive(deadline);

  if (selected === APPROVE_OPTION) {
    return {
      approved: true,
      state: "approved",
    };
  }

  if (selected === sessionOption) {
    if (options?.sessionScope) {
      const scope = await ui.select(
        `${title}\nApply this session grant to:`,
        [
          options.sessionScope.subagentLabel,
          options.sessionScope.servingSessionLabel,
        ],
        deadline ? dialogOptions(deadline) : undefined,
      );
      assertDeadlineActive(deadline);
      return {
        approved: true,
        // A cancelled scope select (undefined) falls back to the
        // least-privilege subagent scope.
        state:
          scope === options.sessionScope.servingSessionLabel
            ? "approved_for_serving_session"
            : "approved_for_session",
      };
    }
    return {
      approved: true,
      state: "approved_for_session",
    };
  }

  if (selected === DENY_WITH_REASON_OPTION) {
    const denialReason = normalizePermissionDenialReason(
      await ui.input(
        `${title}\nShare why this request was denied (optional).`,
        "Reason shown back to the agent",
        deadline ? dialogOptions(deadline) : undefined,
      ),
    );
    assertDeadlineActive(deadline);

    return createDeniedPermissionDecision(denialReason);
  }

  return createDeniedPermissionDecision();
}

function dialogOptions(deadline: ForwardingDeadline): ExtensionUIDialogOptions {
  assertDeadlineActive(deadline);
  return {
    signal: deadline.signal,
    timeout: deadline.expiresAt - Date.now(),
  };
}

function assertDeadlineActive(deadline: ForwardingDeadline | undefined): void {
  if (isForwardingDeadlineExpired(deadline)) {
    throw new ForwardedPermissionDeadlineExpiredError();
  }
}
