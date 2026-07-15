import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InteractivePromptQueue } from "#src/authority/interactive-prompt-queue";
import type {
  PermissionPromptDecision,
  requestPermissionDecisionFromUi,
} from "#src/authority/permission-dialog";
import type { SubagentSessionRegistry } from "#src/authority/subagent-registry";
import type { PermissionEventBus } from "#src/permission-events";
import type { DebugReviewLogger } from "#src/session-logger";
import { ParentAuthorizer } from "./approval-escalator";
import { DenyingAuthorizer } from "./denying-authorizer";
import { LocalUserAuthorizer } from "./local-user-authorizer";
import type { PromptPermissionDetails } from "./permission-prompter";
import type { SubagentDetector } from "./subagent-detection";

/**
 * The live-authority role: on `ask`, an `Authorizer` rules on a single
 * request and is told the decision.
 *
 * One method, one responsibility. `DenyingAuthorizer` ignores `details`;
 * `LocalUserAuthorizer` reads `message`/`sessionLabel` and derives the UI
 * event from it; `ParentAuthorizer` reads `message` and derives the
 * forwarded display from it.
 */
export interface Authorizer {
  authorize(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
}

/** Construction inputs for {@link selectAuthorizer}. */
export interface AuthorizerSelectionDeps {
  /** Single owner of subagent detection; the ParentAuthorizer-selection predicate. */
  detection: SubagentDetector;
  /** Event bus used by `LocalUserAuthorizer` for the `permissions:ui_prompt` broadcast. */
  events: PermissionEventBus;
  /** Shared queue for complete local UI interactions. */
  queue: InteractivePromptQueue;
  /** Injected for testability; production callers pass the real function. */
  requestPermissionDecisionFromUi: typeof requestPermissionDecisionFromUi;
  /** Forwarding directory `ParentAuthorizer` reads/writes request and response files under. */
  forwardingDir: string;
  /** In-process subagent session registry for forwarding target resolution. */
  registry?: SubagentSessionRegistry;
  logger: DebugReviewLogger;
}

/**
 * Select the `Authorizer` for the current context: the single owner of the
 * three-way `hasUI` / `isSubagent` / deny dispatch.
 *
 * Evaluated once per session activation (`AuthorizerSelection.activate`),
 * replacing the re-derivation of the same predicates across
 * `PromptingGateway`, `PermissionPrompter`, and `ApprovalEscalator`.
 */
export function selectAuthorizer(
  ctx: ExtensionContext,
  deps: AuthorizerSelectionDeps,
): Authorizer {
  if (ctx.hasUI) {
    return new LocalUserAuthorizer({
      ui: ctx.ui,
      events: deps.events,
      queue: deps.queue,
      requestPermissionDecisionFromUi: deps.requestPermissionDecisionFromUi,
    });
  }
  if (deps.detection.isSubagent(ctx)) {
    return new ParentAuthorizer(ctx, {
      forwardingDir: deps.forwardingDir,
      registry: deps.registry,
      logger: deps.logger,
    });
  }
  return new DenyingAuthorizer();
}
