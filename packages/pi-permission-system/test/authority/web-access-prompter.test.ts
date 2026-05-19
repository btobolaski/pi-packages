import { describe, expect, it, vi } from "vitest";
import { WebAccessPrompter } from "#src/authority/web-access-prompter";
import { PERMISSIONS_UI_PROMPT_CHANNEL } from "#src/permission-events";
import { makeCtx, makeEvents } from "#test/helpers/handler-fixtures";

describe("WebAccessPrompter", () => {
  it("brackets the local domain prompt with audit entries and emits the UI event", async () => {
    const logger = { review: vi.fn() };
    const events = makeEvents();
    const ctx = makeCtx();
    vi.mocked(ctx.ui.select).mockResolvedValue("Yes, always allow example.com");
    const prompter = new WebAccessPrompter(logger, events);

    const result = await prompter.prompt(
      ctx,
      {
        requestId: "web-1",
        source: "tool_call",
        agentName: null,
        message: "Allow fetch_content to access example.com?",
        toolCallId: "tc-1",
        toolName: "fetch_content",
      },
      "example.com",
    );

    expect(result.domainAction).toBe("allow_persist");
    expect(logger.review.mock.calls.map(([event]) => event)).toEqual([
      "permission_request.waiting",
      "permission_request.approved",
    ]);
    expect(events.emit).toHaveBeenCalledWith(
      PERMISSIONS_UI_PROMPT_CHANNEL,
      expect.objectContaining({
        requestId: "web-1",
        surface: "fetch_content",
        value: "example.com",
      }),
    );
  });
});
