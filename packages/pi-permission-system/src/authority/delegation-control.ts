import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withPermissionSignal } from "#src/authority/forwarded-transaction";
import type { ForwarderContext } from "#src/authority/forwarder-context";
import { getSessionId } from "#src/authority/forwarder-context";
import {
  isErrnoCode,
  logPermissionForwardingWarning,
  safeDeleteFile,
  sleep,
  writeJsonFileAtomic,
  writeJsonFileAtomicIfAbsent,
} from "#src/authority/forwarding-io";
import {
  SERVING_HEARTBEAT_REFRESH_MS,
  SERVING_HEARTBEAT_STALE_MS,
  type ServingHeartbeatStore,
} from "#src/authority/forwarding-liveness";
import {
  DELEGATION_CONTROL_DIRECTORY,
  type DelegationHandshake,
  type DelegationIdentity,
  type DelegationReady,
  INTERACTIVE_DELEGATION_CAPABILITY,
  isDelegationId,
  sameDelegationIdentity,
} from "#src/authority/permission-delegation";
import {
  encodeSessionIdForPath,
  normalizePermissionForwardingSessionId,
  PERMISSION_FORWARDING_POLL_INTERVAL_MS,
  PERMISSION_FORWARDING_TIMEOUT_MS,
} from "#src/authority/permission-forwarding";
import type { DebugReviewLogger } from "#src/session-logger";

const REQUESTS_DIRECTORY = "requests";
const RESPONSES_DIRECTORY = "responses";
const CONSUMED_DIRECTORY = "consumed";
const CHILD_HEARTBEATS_DIRECTORY = "children";
const REVOCATIONS_DIRECTORY = "revocations";

type DelegationControlRequest = {
  capability: typeof INTERACTIVE_DELEGATION_CAPABILITY;
  delegationId: string;
  identity: DelegationIdentity;
};

type DelegationControlResponse = DelegationReady & {
  accepted: boolean;
  identity: DelegationIdentity;
};

type ChildHeartbeat = {
  delegationId: string;
  childSessionId: string;
  pid: number;
  updatedAt: number;
};

interface ControlLocation {
  root: string;
  parentSessionId: string;
  requests: string;
  responses: string;
  consumed: string;
  children: string;
  revocations: string;
}

export interface DelegationControlServerDeps {
  forwardingDir: string;
  logger: DebugReviewLogger;
  /** True only after this instance installed its normal dialog authority. */
  canServe(ctx: ForwarderContext): boolean;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Parent-owned control plane. It is intentionally separate from forwarded
 * permission requests so a pending human dialog never stalls readiness work.
 */
export class DelegationControlServer {
  private readonly bindings = new Map<string, DelegationIdentity>();
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(private readonly deps: DelegationControlServerDeps) {
    this.now = deps.now ?? Date.now;
    this.isProcessAlive = deps.isProcessAlive ?? isRunningProcess;
  }

  process(ctx: ForwarderContext): void {
    const parentSessionId = normalizePermissionForwardingSessionId(
      getSessionId(ctx),
    );
    if (!parentSessionId || !this.deps.canServe(ctx)) {
      return;
    }
    const location = locationFor(this.deps.forwardingDir, parentSessionId);
    if (!existsSync(location.requests)) {
      return;
    }
    this.processRevocations(location);
    this.pruneDeadBindings(location);
    for (const name of listJson(location.requests)) {
      const requestPath = join(location.requests, name);
      const request = readRequest(requestPath);
      if (!request || name !== `${request.delegationId}.json`) {
        safeDeleteFile(
          this.deps.logger,
          requestPath,
          "invalid delegation request",
        );
        continue;
      }
      if (
        request.identity.parentSessionId === parentSessionId &&
        this.isBindingLive(request.delegationId, request.identity)
      ) {
        const acknowledged = readResponse(
          join(location.responses, `${request.delegationId}.json`),
        );
        if (
          acknowledged?.accepted &&
          matchesResponse(acknowledged, request.identity, request.delegationId)
        ) {
          // A failed unlink must not turn this instance's live ACK into a replay rejection.
          safeDeleteFile(this.deps.logger, requestPath, "delegation request");
          continue;
        }
      }
      let response = this.accept(parentSessionId, request);
      try {
        ensureLocation(location);
        if (
          response.accepted &&
          !writeJsonFileAtomicIfAbsent(
            this.deps.logger,
            join(location.consumed, `${request.delegationId}.json`),
            { delegationId: request.delegationId },
          )
        ) {
          this.bindings.delete(request.delegationId);
          response = { ...response, accepted: false };
        }
        writeJsonFileAtomic(
          this.deps.logger,
          join(location.responses, `${request.delegationId}.json`),
          response,
        );
        safeDeleteFile(this.deps.logger, requestPath, "delegation request");
      } catch (error) {
        if (response.accepted) {
          this.bindings.delete(request.delegationId);
        }
        logPermissionForwardingWarning(
          this.deps.logger,
          `Failed to publish delegation control response '${request.delegationId}'`,
          error,
        );
      }
    }
  }

  revokeAll(): void {
    for (const [delegationId, identity] of this.bindings) {
      const location = locationFor(
        this.deps.forwardingDir,
        identity.parentSessionId,
      );
      writeRevocation(
        this.deps.logger,
        location,
        delegationId,
        identity.childSessionId,
      );
    }
    this.bindings.clear();
  }

  /** Re-read requester liveness immediately before committing, not only on ticks. */
  isBindingLive(delegationId: string, identity: DelegationIdentity): boolean {
    const bound = this.bindings.get(delegationId);
    if (!bound || !sameDelegationIdentity(bound, identity)) return false;
    const location = locationFor(
      this.deps.forwardingDir,
      bound.parentSessionId,
    );
    return (
      !existsSync(join(location.revocations, `${delegationId}.json`)) &&
      isLiveChildHeartbeat(
        readChildHeartbeat(join(location.children, `${delegationId}.json`)),
        delegationId,
        bound.childSessionId,
        this.now(),
        this.isProcessAlive,
      )
    );
  }

  private accept(
    parentSessionId: string,
    request: DelegationControlRequest,
  ): DelegationControlResponse {
    const reject = (): DelegationControlResponse => ({
      capability: INTERACTIVE_DELEGATION_CAPABILITY,
      delegationId: request.delegationId,
      parentSessionId,
      childSessionId: request.identity.childSessionId,
      identity: request.identity,
      accepted: false,
    });
    if (
      request.identity.parentSessionId !== parentSessionId ||
      request.identity.childSessionId === parentSessionId
    ) {
      return reject();
    }
    const location = locationFor(this.deps.forwardingDir, parentSessionId);
    const heartbeat = readChildHeartbeat(
      join(location.children, `${request.delegationId}.json`),
    );
    if (
      existsSync(join(location.consumed, `${request.delegationId}.json`)) ||
      !isLiveChildHeartbeat(
        heartbeat,
        request.delegationId,
        request.identity.childSessionId,
        this.now(),
        this.isProcessAlive,
      )
    ) {
      return reject();
    }
    this.bindings.set(request.delegationId, request.identity);
    return {
      capability: INTERACTIVE_DELEGATION_CAPABILITY,
      delegationId: request.delegationId,
      parentSessionId,
      childSessionId: request.identity.childSessionId,
      identity: request.identity,
      accepted: true,
    };
  }

  private processRevocations(location: ControlLocation): void {
    for (const [delegationId, binding] of this.bindings) {
      const revocation = readRevocation(
        join(location.revocations, `${delegationId}.json`),
      );
      if (
        revocation?.delegationId === delegationId &&
        revocation.childSessionId === binding.childSessionId
      ) {
        this.bindings.delete(delegationId);
      }
      // Tombstones outlive a parent replacement so the original child sees the
      // loss even if the replacement processes this directory first.
    }
  }

  private pruneDeadBindings(location: ControlLocation): void {
    for (const [delegationId, identity] of this.bindings) {
      const heartbeat = readChildHeartbeat(
        join(location.children, `${delegationId}.json`),
      );
      if (
        !isLiveChildHeartbeat(
          heartbeat,
          delegationId,
          identity.childSessionId,
          this.now(),
          this.isProcessAlive,
        )
      ) {
        this.bindings.delete(delegationId);
        writeRevocation(
          this.deps.logger,
          location,
          delegationId,
          identity.childSessionId,
        );
      }
    }
  }
}

export interface DelegationControlClientDeps {
  forwardingDir: string;
  logger: DebugReviewLogger;
  heartbeats: Pick<ServingHeartbeatStore, "getLiveHeartbeat">;
  now?: () => number;
  pid?: number;
  timeoutMs?: () => number;
}

/** Filesystem handshake client used by a required child service. */
export class DelegationControlClient implements DelegationHandshake {
  private readonly active = new Map<
    string,
    {
      location: ControlLocation;
      timer: NodeJS.Timeout;
      childSessionId: string;
      parentSessionId: string;
      controller: AbortController;
    }
  >();
  private readonly now: () => number;
  private readonly pid: number;
  private readonly timeoutMs: () => number;

  constructor(private readonly deps: DelegationControlClientDeps) {
    this.now = deps.now ?? Date.now;
    this.pid = deps.pid ?? process.pid;
    this.timeoutMs = deps.timeoutMs ?? (() => PERMISSION_FORWARDING_TIMEOUT_MS);
  }

  async connect(
    identity: DelegationIdentity,
    delegationId: string,
    options: { signal: AbortSignal },
  ): Promise<DelegationReady> {
    if (!isDelegationId(delegationId) || options.signal.aborted) {
      throw new Error("Delegation connection cancelled");
    }
    const location = locationFor(
      this.deps.forwardingDir,
      identity.parentSessionId,
    );
    if (!this.isParentCapable(identity.parentSessionId)) {
      throw new Error(
        "Delegation parent is unavailable or does not support the capability",
      );
    }
    ensureLocation(location);
    this.startChildHeartbeat(location, delegationId, identity.childSessionId);
    const bindingSignal = this.getBindingSignal(delegationId);
    if (!bindingSignal || bindingSignal.aborted) {
      throw new Error("Delegation child liveness is unavailable");
    }
    const signal = AbortSignal.any([options.signal, bindingSignal]);
    const requestPath = join(location.requests, `${delegationId}.json`);
    try {
      writeJsonFileAtomic(this.deps.logger, requestPath, {
        capability: INTERACTIVE_DELEGATION_CAPABILITY,
        delegationId,
        identity,
      } satisfies DelegationControlRequest);
    } catch (error) {
      this.discardBinding(delegationId);
      throw error;
    }

    const deadline = this.now() + this.timeoutMs();
    const responsePath = join(location.responses, `${delegationId}.json`);
    while (this.now() < deadline) {
      if (signal.aborted) {
        break;
      }
      const response = readResponse(responsePath);
      if (response) {
        safeDeleteFile(this.deps.logger, requestPath, "delegation request");
        if (
          response.accepted &&
          matchesResponse(response, identity, delegationId)
        ) {
          if (
            !this.isParentCapable(identity.parentSessionId) ||
            existsSync(join(location.revocations, `${delegationId}.json`)) ||
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Recheck after response IO before accepting readiness.
            signal.aborted
          ) {
            this.discardBinding(delegationId);
            throw new Error("Delegation parent is unavailable");
          }
          return {
            capability: response.capability,
            delegationId: response.delegationId,
            parentSessionId: response.parentSessionId,
            childSessionId: response.childSessionId,
          };
        }
        this.discardBinding(delegationId);
        throw new Error("Delegation parent rejected the binding");
      }
      if (!this.isParentCapable(identity.parentSessionId)) {
        break;
      }
      try {
        await withPermissionSignal(
          sleep(
            Math.min(
              PERMISSION_FORWARDING_POLL_INTERVAL_MS,
              deadline - this.now(),
            ),
          ),
          signal,
        );
      } catch {
        break;
      }
    }
    safeDeleteFile(this.deps.logger, requestPath, "delegation request");
    this.discardBinding(delegationId);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The signal may have aborted during the preceding await.
    if (options.signal.aborted) {
      throw new Error("Delegation connection cancelled");
    }
    throw new Error("Delegation parent is unavailable");
  }

  close(): void {
    for (const delegationId of [...this.active.keys()]) {
      this.discardBinding(delegationId);
    }
  }

  private isParentCapable(parentSessionId: string): boolean {
    return (
      this.deps.heartbeats
        .getLiveHeartbeat(parentSessionId)
        ?.capabilities.includes(INTERACTIVE_DELEGATION_CAPABILITY) === true
    );
  }

  getBindingSignal(delegationId: string): AbortSignal | undefined {
    return this.active.get(delegationId)?.controller.signal;
  }

  isBindingLive(delegationId: string): boolean {
    const active = this.active.get(delegationId);
    if (!active || active.controller.signal.aborted) return false;
    if (
      !this.isParentCapable(active.parentSessionId) ||
      existsSync(join(active.location.revocations, `${delegationId}.json`))
    ) {
      this.discardBinding(delegationId);
      return false;
    }
    return true;
  }

  discardBinding(delegationId: string): void {
    const active = this.active.get(delegationId);
    if (!active) return;
    // Detach ownership before notifying synchronous abort listeners, which may retry.
    this.active.delete(delegationId);
    clearInterval(active.timer);
    safeDeleteFile(
      this.deps.logger,
      join(active.location.children, `${delegationId}.json`),
      "delegation child heartbeat",
    );
    const revocation = readRevocation(
      join(active.location.revocations, `${delegationId}.json`),
    );
    if (
      revocation?.delegationId !== delegationId ||
      revocation.childSessionId !== active.childSessionId
    ) {
      writeRevocation(
        this.deps.logger,
        active.location,
        delegationId,
        active.childSessionId,
      );
    }
    active.controller.abort();
  }

  private startChildHeartbeat(
    location: ControlLocation,
    delegationId: string,
    childSessionId: string,
  ): void {
    const controller = new AbortController();
    const publish = (): boolean => {
      try {
        writeJsonFileAtomic(
          this.deps.logger,
          join(location.children, `${delegationId}.json`),
          {
            delegationId,
            childSessionId,
            pid: this.pid,
            updatedAt: this.now(),
          } satisfies ChildHeartbeat,
        );
        return true;
      } catch (error) {
        logPermissionForwardingWarning(
          this.deps.logger,
          `Failed to publish child liveness for '${delegationId}'`,
          error,
        );
        return false;
      }
    };
    if (!publish()) {
      controller.abort();
      return;
    }
    const timer = setInterval(() => {
      if (
        !this.isParentCapable(location.parentSessionId) ||
        existsSync(join(location.revocations, `${delegationId}.json`))
      ) {
        this.discardBinding(delegationId);
        return;
      }
      if (!publish()) this.discardBinding(delegationId);
    }, SERVING_HEARTBEAT_REFRESH_MS);
    this.active.set(delegationId, {
      location,
      timer,
      childSessionId,
      parentSessionId: location.parentSessionId,
      controller,
    });
  }
}

function writeRevocation(
  logger: DebugReviewLogger,
  location: ControlLocation,
  delegationId: string,
  childSessionId: string,
): void {
  try {
    ensureLocation(location);
    writeJsonFileAtomic(
      logger,
      join(location.revocations, `${delegationId}.json`),
      { delegationId, childSessionId },
    );
  } catch (error) {
    logPermissionForwardingWarning(
      logger,
      `Failed to revoke delegation '${delegationId}'`,
      error,
    );
  }
}

function locationFor(
  forwardingDir: string,
  parentSessionId: string,
): ControlLocation {
  const parent = normalizePermissionForwardingSessionId(parentSessionId);
  if (!parent) throw new Error("Invalid delegation parent session");
  const root = join(
    forwardingDir,
    DELEGATION_CONTROL_DIRECTORY,
    encodeSessionIdForPath(parent),
  );
  return {
    root,
    parentSessionId: parent,
    requests: join(root, REQUESTS_DIRECTORY),
    responses: join(root, RESPONSES_DIRECTORY),
    consumed: join(root, CONSUMED_DIRECTORY),
    children: join(root, CHILD_HEARTBEATS_DIRECTORY),
    revocations: join(root, REVOCATIONS_DIRECTORY),
  };
}

function ensureLocation(location: ControlLocation): void {
  for (const path of [
    location.requests,
    location.responses,
    location.consumed,
    location.children,
    location.revocations,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function listJson(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

function readRequest(path: string): DelegationControlRequest | null {
  try {
    return asRequest(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

function readResponse(path: string): DelegationControlResponse | null {
  try {
    return asResponse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

function readChildHeartbeat(path: string): ChildHeartbeat | null {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as Partial<ChildHeartbeat>;
    return typeof value.delegationId === "string" &&
      typeof value.childSessionId === "string" &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.updatedAt === "number" &&
      Number.isFinite(value.updatedAt)
      ? (value as ChildHeartbeat)
      : null;
  } catch {
    return null;
  }
}

function isLiveChildHeartbeat(
  heartbeat: ChildHeartbeat | null,
  delegationId: string,
  childSessionId: string,
  now: number,
  isProcessAlive: (pid: number) => boolean,
): heartbeat is ChildHeartbeat {
  return (
    heartbeat !== null &&
    heartbeat.delegationId === delegationId &&
    heartbeat.childSessionId === childSessionId &&
    isProcessAlive(heartbeat.pid) &&
    now - heartbeat.updatedAt < SERVING_HEARTBEAT_STALE_MS
  );
}

function readRevocation(
  path: string,
): { delegationId: string; childSessionId: string } | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as {
      delegationId?: unknown;
      childSessionId?: unknown;
    };
    return isDelegationId(value.delegationId) &&
      typeof value.childSessionId === "string"
      ? {
          delegationId: value.delegationId,
          childSessionId: value.childSessionId,
        }
      : null;
  } catch {
    return null;
  }
}

function asRequest(value: unknown): DelegationControlRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<DelegationControlRequest>;
  const identity = candidate.identity;
  if (
    candidate.capability !== INTERACTIVE_DELEGATION_CAPABILITY ||
    !isDelegationId(candidate.delegationId) ||
    !identity ||
    !normalizePermissionForwardingSessionId(identity.parentSessionId) ||
    !normalizePermissionForwardingSessionId(identity.childSessionId) ||
    identity.parentSessionId === identity.childSessionId ||
    typeof identity.agentName !== "string" ||
    !identity.agentName.trim() ||
    typeof identity.childCwd !== "string" ||
    !identity.childCwd.trim()
  )
    return null;
  return {
    capability: candidate.capability,
    delegationId: candidate.delegationId,
    identity: Object.freeze({ ...identity }),
  };
}

function asResponse(value: unknown): DelegationControlResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<DelegationControlResponse>;
  return candidate.capability === INTERACTIVE_DELEGATION_CAPABILITY &&
    isDelegationId(candidate.delegationId) &&
    typeof candidate.parentSessionId === "string" &&
    typeof candidate.childSessionId === "string" &&
    candidate.identity !== undefined &&
    asRequest({
      capability: candidate.capability,
      delegationId: candidate.delegationId,
      identity: candidate.identity,
    }) !== null &&
    typeof candidate.accepted === "boolean"
    ? (candidate as DelegationControlResponse)
    : null;
}

function matchesResponse(
  response: DelegationControlResponse,
  identity: DelegationIdentity,
  delegationId: string,
): boolean {
  return (
    response.delegationId === delegationId &&
    response.parentSessionId === identity.parentSessionId &&
    response.childSessionId === identity.childSessionId &&
    sameDelegationIdentity(response.identity, identity)
  );
}

function isRunningProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoCode(error, "EPERM");
  }
}
