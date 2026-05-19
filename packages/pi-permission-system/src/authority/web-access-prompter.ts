import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  requestWebAccessPermissionFromUi,
  type WebAccessPermissionDecision,
} from "#src/authority/permission-dialog";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import {
  emitUiPromptEvent,
  type PermissionEventBus,
} from "#src/permission-events";
import type { ReviewLogger } from "#src/session-logger";

/** Local-only prompt surface for per-domain fetch_content decisions. */
export class WebAccessPrompter {
  constructor(
    private readonly logger: ReviewLogger,
    private readonly events: PermissionEventBus,
  ) {}

  async prompt(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
    domain: string,
  ): Promise<WebAccessPermissionDecision> {
    this.writeReviewEntry("permission_request.waiting", details);
    emitUiPromptEvent(this.events, {
      requestId: details.requestId,
      source: details.source,
      surface: details.toolName ?? "fetch_content",
      value: domain,
      agentName: details.agentName,
      message: details.message,
      forwarding: null,
    });

    const decision = await requestWebAccessPermissionFromUi(
      ctx.ui,
      "Permission request",
      details.message,
      domain,
    );

    this.writeReviewEntry(
      decision.approved
        ? "permission_request.approved"
        : "permission_request.denied",
      details,
      decision.state,
      decision.denialReason,
    );
    return decision;
  }

  private writeReviewEntry(
    event: string,
    details: PromptPermissionDetails,
    resolution?: string,
    denialReason?: string,
  ): void {
    this.logger.review(event, {
      requestId: details.requestId,
      source: details.source,
      agentName: details.agentName,
      message: details.message,
      toolCallId: details.toolCallId ?? null,
      toolName: details.toolName ?? null,
      skillName: details.skillName ?? null,
      path: details.path ?? null,
      command: details.command ?? null,
      target: details.target ?? null,
      toolInputPreview: details.toolInputPreview ?? null,
      resolution: resolution ?? null,
      denialReason: denialReason ?? null,
    });
  }
}
