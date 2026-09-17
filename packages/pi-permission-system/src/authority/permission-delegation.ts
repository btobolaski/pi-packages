import type { PermissionsService } from "#src/service";
import { normalizePermissionForwardingSessionId } from "./permission-forwarding";

export const INTERACTIVE_DELEGATION_CAPABILITY = "interactive-delegation-v1";
export const DELEGATION_CONTROL_DIRECTORY = "delegations";

export function isDelegationId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}
export const PERMISSION_DELEGATION_REQUIRED_ENV =
  "PI_PERMISSION_DELEGATION_REQUIRED";

/** Internal teardown capability; deliberately absent from the public service interface. */
export function hasDelegationCloser(
  service: PermissionsService,
): service is PermissionsService & { closeDelegation(): void } {
  return (
    "closeDelegation" in service &&
    typeof service.closeDelegation === "function"
  );
}

export interface DelegationIdentity {
  parentSessionId: string;
  childSessionId: string;
  agentName: string;
  childCwd: string;
}

export interface DelegationReady {
  capability: typeof INTERACTIVE_DELEGATION_CAPABILITY;
  delegationId: string;
  parentSessionId: string;
  childSessionId: string;
}

export type DelegationFailureCode =
  | "cancelled"
  | "closed"
  | "conflicting_identity"
  | "invalid_identity"
  | "not_required"
  | "unavailable";

export type DelegationState =
  | { status: "not-required" }
  | { status: "unbound" }
  | {
      status: "connecting";
      identity: DelegationIdentity;
      delegationId: string;
    }
  | {
      status: "ready";
      identity: DelegationIdentity;
      delegationId: string;
    }
  | {
      status: "unavailable";
      code: DelegationFailureCode;
      identity: DelegationIdentity;
      delegationId: string;
    }
  | { status: "closed"; code: "closed" };

export interface PendingDelegatedWait {
  readonly delegationId: string;
  readonly childSessionId: string;
  readonly requestId: string;
}

/** Runtime-only routing capability; never exported by the cross-extension service. */
export interface DelegationBinding {
  readonly identity: DelegationIdentity;
  readonly delegationId: string;
  readonly signal: AbortSignal;
  isLive(): boolean;
  beginWait(requestId: string): () => void;
}

export interface DelegationHandshake {
  /** Idempotently retire only this attempt, including any lower-level admission. */
  discardBinding(delegationId: string): void;
  isBindingLive(delegationId: string): boolean;
  connect(
    identity: DelegationIdentity,
    delegationId: string,
    options: { signal: AbortSignal },
  ): Promise<DelegationReady>;
  close(): void;
  getBindingSignal(delegationId: string): AbortSignal | undefined;
}

export interface DelegationRuntimeContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}

export interface DelegationRuntime {
  getContext(): DelegationRuntimeContext | null;
  canonicalizeCwd(value: string): string;
}

export class DelegationConnectionError extends Error {
  constructor(
    readonly code: DelegationFailureCode,
    options?: ErrorOptions,
  ) {
    super(`Permission delegation is unavailable: ${code}`, options);
    this.name = "DelegationConnectionError";
  }
}

export function isDelegationRequired(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[PERMISSION_DELEGATION_REQUIRED_ENV];
  if (value === undefined) {
    return false;
  }
  if (value !== "1") {
    throw new Error(
      `${PERMISSION_DELEGATION_REQUIRED_ENV} must be "1" or unset; received ${JSON.stringify(value)}`,
    );
  }
  return true;
}

/**
 * Owns one child service's explicit delegation lifecycle.
 *
 * The handshake remains injected until the forwarding control protocol owns it;
 * this class validates local identity and never accepts a decision or grant.
 */
export class PermissionDelegation {
  private state: DelegationState;
  private connection: Promise<DelegationReady> | null = null;
  private controller = new AbortController();
  private readonly waits = new Map<string, PendingDelegatedWait>();
  private readonly observers = new Set<
    (pending: readonly PendingDelegatedWait[]) => void
  >();

  constructor(
    private readonly runtime: DelegationRuntime,
    private readonly handshake: DelegationHandshake,
    required = isDelegationRequired(),
  ) {
    this.state = freezeState(
      required ? { status: "unbound" } : { status: "not-required" },
    );
  }

  getState(): DelegationState {
    this.revalidateBinding();
    return this.state;
  }

  private revalidateBinding(): void {
    const state = this.state;
    if (
      state.status === "ready" &&
      !this.handshake.isBindingLive(state.delegationId) &&
      this.state === state
    ) {
      // Polling detects loss before the heartbeat tick. If polling already
      // fired the abort listener, that listener owns the transition; otherwise
      // fail closed even when the handshake provides no abort notification.
      this.markUnavailable(state.identity, state.delegationId, "unavailable");
    }
  }

  private markUnavailable(
    identity: DelegationIdentity,
    delegationId: string,
    code: DelegationFailureCode,
  ): void {
    this.connection = null;
    this.state = freezeState({
      status: "unavailable",
      code,
      identity,
      delegationId,
    });
  }

  getBinding(): DelegationBinding | undefined {
    const state = this.getState();
    if (state.status !== "ready") return undefined;
    const bindingSignal = this.handshake.getBindingSignal(state.delegationId);
    const signal = bindingSignal
      ? AbortSignal.any([this.controller.signal, bindingSignal])
      : this.controller.signal;
    return Object.freeze({
      identity: state.identity,
      delegationId: state.delegationId,
      signal,
      isLive: () => {
        if (signal.aborted) return false;
        this.revalidateBinding();
        return (
          this.state.status === "ready" &&
          this.state.delegationId === state.delegationId
        );
      },
      beginWait: (requestId: string) => {
        const key = `${state.delegationId}:${requestId}`;
        const wait = Object.freeze({
          delegationId: state.delegationId,
          childSessionId: state.identity.childSessionId,
          requestId,
        });
        this.waits.set(key, wait);
        this.publishWaits();
        return () => {
          if (this.waits.get(key) === wait) {
            this.waits.delete(key);
            this.publishWaits();
          }
        };
      },
    });
  }

  subscribeWaits(
    listener: (pending: readonly PendingDelegatedWait[]) => void,
  ): () => void {
    if (this.state.status !== "closed") this.observers.add(listener);
    this.notifyObserver(listener);
    return () => {
      this.observers.delete(listener);
    };
  }

  private publishWaits(): void {
    for (const listener of this.observers) this.notifyObserver(listener);
  }

  private notifyObserver(
    listener: (pending: readonly PendingDelegatedWait[]) => unknown,
  ): void {
    try {
      void Promise.resolve(
        listener(Object.freeze([...this.waits.values()])),
      ).catch(() => undefined);
    } catch {
      // Observers have no authority over the permission lifetime.
    }
  }

  connect(
    identity: DelegationIdentity,
    options?: { signal?: AbortSignal },
  ): Promise<DelegationReady> {
    this.revalidateBinding();
    if (this.state.status === "closed") {
      return Promise.reject(new DelegationConnectionError("closed"));
    }
    if (this.state.status === "not-required") {
      return Promise.reject(new DelegationConnectionError("not_required"));
    }

    let validated: DelegationIdentity;
    try {
      validated = this.validateIdentity(identity);
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new DelegationConnectionError("invalid_identity"),
      );
    }

    if (
      "identity" in this.state &&
      !sameDelegationIdentity(this.state.identity, validated)
    ) {
      return Promise.reject(
        new DelegationConnectionError("conflicting_identity"),
      );
    }

    if (this.connection) return this.connection;

    const delegationId = crypto.randomUUID();
    const signal = options?.signal
      ? AbortSignal.any([this.controller.signal, options.signal])
      : this.controller.signal;
    if (signal.aborted) {
      return Promise.reject(new DelegationConnectionError("cancelled"));
    }
    const boundIdentity = freezeIdentity(validated);
    this.state = freezeState({
      status: "connecting",
      identity: boundIdentity,
      delegationId,
    });
    const connection = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return this.handshake.connect(boundIdentity, delegationId, { signal });
      })
      .then((ready) => {
        this.assertReady(ready, boundIdentity, delegationId, signal);
        this.state = freezeState({
          status: "ready",
          identity: boundIdentity,
          delegationId,
        });
        const bindingSignal = this.handshake.getBindingSignal(delegationId);
        if (bindingSignal?.aborted) {
          throw new DelegationConnectionError("unavailable");
        }
        bindingSignal?.addEventListener(
          "abort",
          () => {
            if (
              this.state.status === "ready" &&
              this.state.delegationId === delegationId
            ) {
              this.markUnavailable(boundIdentity, delegationId, "unavailable");
            }
          },
          { once: true },
        );
        return Object.freeze({ ...ready });
      })
      .catch((error: unknown) => {
        this.handshake.discardBinding(delegationId);
        const code =
          this.state.status === "closed"
            ? "closed"
            : failureCode(error, signal);
        if (this.state.status !== "closed") {
          this.markUnavailable(boundIdentity, delegationId, code);
        }
        throw error instanceof DelegationConnectionError && error.code === code
          ? error
          : new DelegationConnectionError(code, { cause: error });
      });
    this.connection = connection;
    return connection;
  }

  close(): void {
    if (this.state.status === "closed") {
      return;
    }
    this.controller.abort(new DelegationConnectionError("closed"));
    this.handshake.close();
    this.connection = null;
    this.state = freezeState({ status: "closed", code: "closed" });
    this.waits.clear();
    this.publishWaits();
    this.observers.clear();
  }

  private validateIdentity(identity: DelegationIdentity): DelegationIdentity {
    const context = this.runtime.getContext();
    const liveChildSessionId = normalizePermissionForwardingSessionId(
      context?.sessionManager.getSessionId(),
    );
    const parentSessionId = normalizePermissionForwardingSessionId(
      identity.parentSessionId,
    );
    const childSessionId = normalizePermissionForwardingSessionId(
      identity.childSessionId,
    );
    if (
      !context ||
      !parentSessionId ||
      !childSessionId ||
      !hasText(identity.agentName) ||
      !hasText(identity.childCwd) ||
      !liveChildSessionId ||
      childSessionId !== liveChildSessionId ||
      parentSessionId === liveChildSessionId
    ) {
      throw new DelegationConnectionError("invalid_identity");
    }

    let expectedCwd: string;
    let suppliedCwd: string;
    try {
      expectedCwd = this.runtime.canonicalizeCwd(context.cwd);
      suppliedCwd = this.runtime.canonicalizeCwd(identity.childCwd);
    } catch {
      throw new DelegationConnectionError("invalid_identity");
    }
    if (expectedCwd !== suppliedCwd) {
      throw new DelegationConnectionError("invalid_identity");
    }
    return {
      parentSessionId,
      childSessionId,
      agentName: identity.agentName,
      childCwd: context.cwd,
    };
  }

  private assertReady(
    ready: DelegationReady,
    identity: DelegationIdentity,
    delegationId: string,
    signal: AbortSignal,
  ): void {
    const capability: string = ready.capability;
    if (
      signal.aborted ||
      capability !== INTERACTIVE_DELEGATION_CAPABILITY ||
      ready.delegationId !== delegationId ||
      ready.parentSessionId !== identity.parentSessionId ||
      ready.childSessionId !== identity.childSessionId
    ) {
      throw new DelegationConnectionError(
        signal.aborted ? "cancelled" : "unavailable",
      );
    }
  }
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function sameDelegationIdentity(
  left: DelegationIdentity,
  right: DelegationIdentity,
): boolean {
  return (
    left.parentSessionId === right.parentSessionId &&
    left.childSessionId === right.childSessionId &&
    left.agentName === right.agentName &&
    left.childCwd === right.childCwd
  );
}

function failureCode(
  error: unknown,
  signal: AbortSignal,
): DelegationFailureCode {
  if (signal.aborted) {
    return signal.reason instanceof DelegationConnectionError &&
      signal.reason.code === "closed"
      ? "closed"
      : "cancelled";
  }
  return error instanceof DelegationConnectionError
    ? error.code
    : "unavailable";
}

function freezeIdentity(identity: DelegationIdentity): DelegationIdentity {
  return Object.freeze({ ...identity });
}

/** Identity was copied and frozen before handshaking; transitions retain it. */
function freezeState(state: DelegationState): DelegationState {
  return Object.freeze({ ...state });
}
