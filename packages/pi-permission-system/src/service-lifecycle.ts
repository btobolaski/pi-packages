import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasDelegationCloser } from "./authority/permission-delegation";
import type { RegisteredChildDetector } from "./authority/subagent-detection";
import { emitReadyEvent, type PermissionEventBus } from "./permission-events";
import {
  getPermissionsService,
  type PermissionsService,
  publishPermissionsService,
  unpublishPermissionsService,
} from "./service";

/** The session-scoped service lifecycle that the lifecycle handler drives. */
export interface ServiceLifecycle {
  prepare(ctx: ExtensionContext): void;
  activate(ctx: ExtensionContext): void;
  teardown(): void;
}

/**
 * Owns the process-global service publication lifecycle for one extension
 * instance.
 *
 * - `prepare` retires the prior owner before replacement serving liveness.
 * - `activate` publishes every service under its exact session id; only a
 *   non-child may select the no-argument parent service, then emits ready.
 * - `teardown` closes delegation, runs subscriptions, then unpublishes.
 */
export class PermissionServiceLifecycle implements ServiceLifecycle {
  constructor(
    private readonly service: PermissionsService,
    private readonly detection: RegisteredChildDetector,
    private readonly events: PermissionEventBus,
    private readonly subscriptions: readonly (() => void)[],
  ) {}

  /** Retire the prior owner before the replacement publishes serving liveness. */
  prepare(ctx: ExtensionContext): void {
    const previous = getPermissionsService(ctx.sessionManager.getSessionId());
    if (previous && previous !== this.service) {
      if (hasDelegationCloser(previous)) previous.closeDelegation();
      // Retired services must not remain discoverable or be retired again by
      // the publication fallback used by callers without this prepare phase.
      unpublishPermissionsService(previous);
    }
  }

  activate(ctx: ExtensionContext): void {
    const isRegisteredChild = this.detection.isRegisteredChild(ctx);
    publishPermissionsService(this.service, ctx.sessionManager.getSessionId(), {
      asDefault:
        !isRegisteredChild &&
        this.service.getDelegationState().status === "not-required",
    });
    emitReadyEvent(this.events);
  }

  teardown(): void {
    if (hasDelegationCloser(this.service)) {
      this.service.closeDelegation();
    }
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    unpublishPermissionsService(this.service);
  }
}
