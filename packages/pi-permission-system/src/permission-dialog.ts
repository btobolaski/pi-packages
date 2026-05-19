export type PermissionDecisionState =
  | "approved"
  | "approved_for_session"
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
};

export interface PermissionDecisionUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
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
): PermissionPromptDecision {
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

export function isPermissionDecisionState(
  value: unknown,
): value is PermissionDecisionState {
  return (
    value === "approved" ||
    value === "approved_for_session" ||
    value === "denied" ||
    value === "denied_with_reason"
  );
}

export interface RequestPermissionOptions {
  /** Override the "for this session" option label (e.g. to show the suggested pattern). */
  sessionLabel?: string;
}

export type WebAccessDomainAction = "allow_persist" | "allow_session";

/**
 * Decision returned by the per-domain `fetch_content` dialog.
 * Extends the standard permission decision with an optional
 * `domainAction` describing how the allow choice should be remembered.
 */
export type WebAccessPermissionDecision = PermissionPromptDecision & {
  domainAction?: WebAccessDomainAction;
  domain?: string;
};

export async function requestWebAccessPermissionFromUi(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
  domain: string,
): Promise<WebAccessPermissionDecision> {
  const persistOption = `Yes, always allow ${domain}`;
  const sessionOption = `Yes, allow ${domain} for this session`;
  const decisionOptions = [
    APPROVE_OPTION,
    persistOption,
    sessionOption,
    DENY_OPTION,
    DENY_WITH_REASON_OPTION,
  ];

  const selected = await ui.select(`${title}\n${message}`, decisionOptions);

  if (selected === APPROVE_OPTION) {
    return { approved: true, state: "approved", domain };
  }

  if (selected === persistOption) {
    return {
      approved: true,
      state: "approved",
      domainAction: "allow_persist",
      domain,
    };
  }

  if (selected === sessionOption) {
    return {
      approved: true,
      state: "approved",
      domainAction: "allow_session",
      domain,
    };
  }

  if (selected === DENY_WITH_REASON_OPTION) {
    const denialReason = normalizePermissionDenialReason(
      await ui.input(
        `${title}\nShare why this request was denied (optional).`,
        "Reason shown back to the agent",
      ),
    );
    return { ...createDeniedPermissionDecision(denialReason), domain };
  }

  return { ...createDeniedPermissionDecision(), domain };
}

export async function requestPermissionDecisionFromUi(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
  options?: RequestPermissionOptions,
): Promise<PermissionPromptDecision> {
  const sessionOption = options?.sessionLabel ?? APPROVE_FOR_SESSION_OPTION;
  const decisionOptions = [
    APPROVE_OPTION,
    sessionOption,
    DENY_OPTION,
    DENY_WITH_REASON_OPTION,
  ] as const;

  const selected = await ui.select(`${title}\n${message}`, [
    ...decisionOptions,
  ]);

  if (selected === APPROVE_OPTION) {
    return {
      approved: true,
      state: "approved",
    };
  }

  if (selected === sessionOption) {
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
      ),
    );

    return createDeniedPermissionDecision(denialReason);
  }

  return createDeniedPermissionDecision();
}
