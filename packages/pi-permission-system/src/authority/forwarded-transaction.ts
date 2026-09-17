import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asDecisionSource } from "./decision-source";
import {
  ensureDirectoryExists,
  writeJsonFileAtomicIfAbsent,
} from "./forwarding-io";
import {
  DELEGATION_CONTROL_DIRECTORY,
  sameDelegationIdentity,
} from "./permission-delegation";
import {
  createUnavailablePermissionDecision,
  type PermissionPromptDecision,
} from "./permission-dialog";
import {
  type DelegatedPermissionTransaction,
  encodeSessionIdForPath,
  FORWARDED_PERMISSION_TIMEOUT_DECISION,
  type ForwardedPermissionRequest,
  type ForwardingDeadline,
  isForwardingDeadlineExpired,
} from "./permission-forwarding";

export type DelegatedRequest = ForwardedPermissionRequest & {
  delegation: DelegatedPermissionTransaction;
  expiresAt: number;
};

export interface DelegatedTerminal {
  transaction: DelegatedPermissionTransaction;
  decision: PermissionPromptDecision;
}

/** The cancellation/commit ordering point is this file's first hard-link publication. */
export function delegatedTerminalPath(
  root: string,
  request: DelegatedRequest,
): string {
  return join(
    root,
    DELEGATION_CONTROL_DIRECTORY,
    encodeSessionIdForPath(request.targetSessionId),
    "transactions",
    encodeSessionIdForPath(request.delegation.delegationId),
    `${encodeSessionIdForPath(request.id)}.json`,
  );
}

export function sameTransaction(
  left: DelegatedPermissionTransaction,
  right: DelegatedPermissionTransaction,
): boolean {
  return (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The left tuple came from untrusted JSON, not a constructed protocol value.
    left.capability === right.capability &&
    left.requestId === right.requestId &&
    left.delegationId === right.delegationId &&
    left.expiresAt === right.expiresAt &&
    sameDelegationIdentity(left.identity, right.identity)
  );
}

/** A missing terminal is pending; an existing malformed one throws and fails closed. */
export function readDelegatedTerminal(
  path: string,
  request: DelegatedRequest,
): PermissionPromptDecision | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error("Unreadable delegated terminal", { cause });
  }
  if (typeof raw !== "object" || raw === null)
    throw new Error("Invalid delegated terminal");
  const value = raw as Partial<DelegatedTerminal>;
  if (
    !value.transaction?.identity ||
    !sameTransaction(value.transaction, request.delegation)
  ) {
    throw new Error("Mismatched delegated terminal");
  }
  const decision = validateDelegatedDecision(value.decision);
  if (!decision) throw new Error("Invalid delegated decision");
  return decision;
}

/** Only consistent child-wire decisions may become authority; serving scope is private. */
export function validateDelegatedDecision(
  value: unknown,
): PermissionPromptDecision | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<
    Record<keyof PermissionPromptDecision, unknown>
  >;
  const source = asDecisionSource(candidate.decidedBy);
  const approvedState =
    candidate.state === "approved" ||
    candidate.state === "approved_for_session";
  const deniedState =
    candidate.state === "denied" || candidate.state === "denied_with_reason";
  if (
    !source ||
    typeof candidate.approved !== "boolean" ||
    !(approvedState || deniedState) ||
    candidate.approved !== approvedState ||
    (candidate.denialReason !== undefined &&
      typeof candidate.denialReason !== "string") ||
    (candidate.confirmationUnavailable !== undefined &&
      candidate.confirmationUnavailable !== true) ||
    (candidate.forwardingTimedOut !== undefined &&
      candidate.forwardingTimedOut !== true) ||
    (candidate.approved &&
      (candidate.confirmationUnavailable || candidate.forwardingTimedOut)) ||
    (candidate.forwardingTimedOut &&
      (!candidate.confirmationUnavailable ||
        candidate.denialReason !==
          FORWARDED_PERMISSION_TIMEOUT_DECISION.denialReason))
  ) {
    return undefined;
  }
  return {
    approved: candidate.approved,
    state: candidate.state as PermissionPromptDecision["state"],
    decidedBy: source,
    ...(candidate.denialReason !== undefined
      ? { denialReason: candidate.denialReason }
      : {}),
    ...(candidate.confirmationUnavailable
      ? { confirmationUnavailable: true as const }
      : {}),
    ...(candidate.forwardingTimedOut
      ? { forwardingTimedOut: true as const }
      : {}),
  };
}

/** Synchronous by design: the serving grant immediately follows the successful link. */
export function publishDelegatedTerminal(
  path: string,
  request: DelegatedRequest,
  decision: PermissionPromptDecision,
): boolean {
  if (!validateDelegatedDecision(decision))
    throw new Error("Invalid delegated decision");
  const directory = dirname(path);
  if (!ensureDirectoryExists(null, directory, "delegated transaction")) {
    throw new Error("Delegated transaction directory unavailable");
  }
  return writeJsonFileAtomicIfAbsent(null, path, {
    transaction: request.delegation,
    decision,
  } satisfies DelegatedTerminal);
}

export function cancelledPermissionDecision(
  deadline?: ForwardingDeadline,
): PermissionPromptDecision {
  return isForwardingDeadlineExpired(deadline)
    ? FORWARDED_PERMISSION_TIMEOUT_DECISION
    : createUnavailablePermissionDecision(
        "The permission request was cancelled or its delegation became unavailable",
      );
}

/** Race a request lifetime, observing late fulfillment/rejection without extending the wait. */
export async function withPermissionSignal<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Permission request cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
