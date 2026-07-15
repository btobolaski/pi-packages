import { describe, expect, it, vi } from "vitest";
import { SerialInteractivePromptQueue } from "#src/authority/interactive-prompt-queue";
import { WebAccessPrompter } from "#src/authority/web-access-prompter";
import { PERMISSIONS_UI_PROMPT_CHANNEL } from "#src/permission-events";
import { makeCtx, makeEvents } from "#test/helpers/handler-fixtures";

describe("WebAccessPrompter", () => {
  it("brackets the local domain prompt with audit entries and emits the UI event", async () => {
    const logger = { review: vi.fn() };
    const events = makeEvents();
    const ctx = makeCtx();
    vi.mocked(ctx.ui.select).mockResolvedValue("Yes, always allow example.com");
    const prompter = new WebAccessPrompter(
      logger,
      events,
      new SerialInteractivePromptQueue(),
    );

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

  it("waits to emit or show UI until the shared queue admits it", async () => {
    const logger = { review: vi.fn() };
    const events = makeEvents();
    const ctx = makeCtx();
    vi.mocked(ctx.ui.select).mockResolvedValue("Yes");
    const queue = new SerialInteractivePromptQueue();
    const blocker = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    const blockerResult = queue.run(() => blocker.promise);
    const prompter = new WebAccessPrompter(logger, events, queue);

    const result = prompter.prompt(
      ctx,
      {
        requestId: "web-queued",
        source: "tool_call",
        agentName: null,
        message: "Allow fetch_content to access example.com?",
        toolCallId: "tc-queued",
        toolName: "fetch_content",
      },
      "example.com",
    );
    await Promise.resolve();

    expect(logger.review).toHaveBeenCalledOnce();
    expect(logger.review).toHaveBeenCalledWith(
      "permission_request.waiting",
      expect.objectContaining({ requestId: "web-queued" }),
    );
    expect(events.emit).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();

    blocker.resolve();
    await blockerResult;
    await expect(result).resolves.toMatchObject({
      approved: true,
      state: "approved",
      domain: "example.com",
    });

    expect(events.emit).toHaveBeenCalledOnce();
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    expect(logger.review.mock.calls.map(([event]) => event)).toEqual([
      "permission_request.waiting",
      "permission_request.approved",
    ]);
  });

  it("propagates UI failures and leaves the shared queue usable", async () => {
    const logger = { review: vi.fn() };
    const events = makeEvents();
    const ctx = makeCtx();
    const uiDecision = Promise.withResolvers<string | undefined>();
    vi.mocked(ctx.ui.select).mockReturnValue(uiDecision.promise);
    const queue = new SerialInteractivePromptQueue();
    const prompter = new WebAccessPrompter(logger, events, queue);

    const result = prompter.prompt(
      ctx,
      {
        requestId: "web-failure",
        source: "tool_call",
        agentName: null,
        message: "Allow fetch_content to access example.com?",
        toolCallId: "tc-failure",
        toolName: "fetch_content",
      },
      "example.com",
    );
    const nextInteraction = vi.fn().mockResolvedValue("next");
    const nextResult = queue.run(nextInteraction);
    await Promise.resolve();

    expect(nextInteraction).not.toHaveBeenCalled();

    uiDecision.reject(new Error("UI closed"));

    await expect(result).rejects.toThrow("UI closed");
    await expect(nextResult).resolves.toBe("next");
    expect(nextInteraction).toHaveBeenCalledOnce();
  });
});
