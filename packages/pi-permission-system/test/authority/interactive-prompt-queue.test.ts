import { describe, expect, it, vi } from "vitest";
import { SerialInteractivePromptQueue } from "#src/authority/interactive-prompt-queue";

describe("SerialInteractivePromptQueue", () => {
  it("admits an interaction when idle", async () => {
    const queue = new SerialInteractivePromptQueue();
    const interaction = vi.fn().mockResolvedValue("approved");

    const result = queue.run(interaction);

    await expect(result).resolves.toBe("approved");
    expect(interaction).toHaveBeenCalledOnce();
  });

  it("does not start a second interaction while the first is unresolved", async () => {
    const queue = new SerialInteractivePromptQueue();
    const first = Promise.withResolvers<string>();
    const secondInteraction = vi.fn().mockResolvedValue("second");

    const firstResult = queue.run(() => first.promise);
    const secondResult = queue.run(secondInteraction);
    await Promise.resolve();

    expect(secondInteraction).not.toHaveBeenCalled();

    first.resolve("first");

    await expect(firstResult).resolves.toBe("first");
    await expect(secondResult).resolves.toBe("second");
    expect(secondInteraction).toHaveBeenCalledOnce();
  });

  it("starts three interactions in FIFO order", async () => {
    const queue = new SerialInteractivePromptQueue();
    const first = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    const second = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    const order: string[] = [];

    const firstResult = queue.run(async () => {
      order.push("first");
      await first.promise;
    });
    const secondResult = queue.run(async () => {
      order.push("second");
      await second.promise;
    });
    const thirdResult = queue.run(async () => {
      order.push("third");
    });
    await Promise.resolve();

    expect(order).toEqual(["first"]);

    first.resolve();
    await firstResult;
    await Promise.resolve();
    expect(order).toEqual(["first", "second"]);

    second.resolve();
    await Promise.all([secondResult, thirdResult]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("preserves distinct interaction return values", async () => {
    const queue = new SerialInteractivePromptQueue();

    const stringResult = queue.run(async () => "allowed");
    const objectResult = queue.run(async () => ({ approved: false }));

    await expect(stringResult).resolves.toBe("allowed");
    await expect(objectResult).resolves.toEqual({ approved: false });
  });

  it.each([
    ["rejection", () => Promise.reject(new Error("rejected")), "rejected"],
    [
      "synchronous throw",
      () => {
        throw new Error("thrown");
      },
      "thrown",
    ],
  ])("propagates a %s and admits the next interaction", async (_name, failure, message) => {
    const queue = new SerialInteractivePromptQueue();
    const nextInteraction = vi.fn().mockResolvedValue("recovered");

    const failedResult = queue.run(failure);
    const nextResult = queue.run(nextInteraction);

    await expect(failedResult).rejects.toThrow(message);
    await expect(nextResult).resolves.toBe("recovered");
    expect(nextInteraction).toHaveBeenCalledOnce();
  });

  it("invalidates active and queued interactions before admitting a new generation", async () => {
    const queue = new SerialInteractivePromptQueue();
    const activeGate = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    let activeSignal: AbortSignal | undefined;
    const queuedInteraction = vi.fn().mockResolvedValue("stale");

    const activeResult = queue.run(async (signal) => {
      activeSignal = signal;
      await activeGate.promise;
      return "active";
    });
    const queuedResult = queue.run(queuedInteraction);
    await Promise.resolve();

    queue.invalidate("The permission session changed.");

    await expect(activeResult).rejects.toMatchObject({
      name: "InteractivePromptCancelledError",
      message: "The permission session changed.",
    });
    await expect(queuedResult).rejects.toMatchObject({
      name: "InteractivePromptCancelledError",
      message: "The permission session changed.",
    });
    expect(activeSignal?.aborted).toBe(true);
    expect(queuedInteraction).not.toHaveBeenCalled();

    await expect(queue.run(async () => "new session")).resolves.toBe(
      "new session",
    );

    activeGate.resolve();
    await Promise.resolve();
    expect(queuedInteraction).not.toHaveBeenCalled();
  });

  it("holds the queue slot for an entire multi-step transaction", async () => {
    const queue = new SerialInteractivePromptQueue();
    const firstStep = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    const secondStep = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    const calls: string[] = [];

    const firstResult = queue.run(async () => {
      calls.push("first:start");
      await firstStep.promise;
      calls.push("first:middle");
      await secondStep.promise;
      calls.push("first:end");
    });
    const secondResult = queue.run(async () => {
      calls.push("second:start");
    });
    await Promise.resolve();

    expect(calls).toEqual(["first:start"]);

    firstStep.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["first:start", "first:middle"]);

    secondStep.resolve();
    await Promise.all([firstResult, secondResult]);
    expect(calls).toEqual([
      "first:start",
      "first:middle",
      "first:end",
      "second:start",
    ]);
  });
});
