export class InteractivePromptCancelledError extends Error {
  override readonly name = "InteractivePromptCancelledError";
}

export interface InteractivePromptQueue {
  run<T>(
    interaction: (signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T>;
}

export interface InteractivePromptQueueLifecycle {
  bind(sessionId: string): void;
  invalidate(reason: string): void;
}

export interface InteractivePromptQueueController
  extends InteractivePromptQueue,
    InteractivePromptQueueLifecycle {}

export class SerialInteractivePromptQueue
  implements InteractivePromptQueueController
{
  private tail: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private sessionId: string | undefined;
  private queues: Map<string, Promise<void>> | undefined;

  /** A replacement instance joins unfinished UI cleanup rather than opening beside it. */
  bind(sessionId: string): void {
    const key = Symbol.for("@gotgenes/pi-permission-system:prompt-queues");
    const global = globalThis as Record<symbol, unknown>;
    global[key] ??= new Map<string, Promise<void>>();
    this.queues = global[key] as Map<string, Promise<void>>;
    this.sessionId = sessionId;
  }

  run<T>(
    interaction: (signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const generationSignal = this.controller.signal;
    const signal = requestSignal
      ? AbortSignal.any([generationSignal, requestSignal])
      : generationSignal;
    const sessionId = this.sessionId;
    const queues = this.queues;
    const predecessor =
      (sessionId ? queues?.get(sessionId) : undefined) ?? this.tail;
    const scheduled = predecessor.then(() => {
      if (signal.aborted) {
        throw cancellationError(signal);
      }
      return interaction(signal);
    });
    const result = rejectWhenAborted(scheduled, signal);
    // Ordering follows the underlying transaction, not the caller's
    // cancellation race. A cancelled middle entry therefore cannot bypass an
    // unfinished predecessor or overlap the next prompt with active cleanup.
    this.tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    if (sessionId && queues) {
      const tail = this.tail;
      queues.set(sessionId, tail);
      void tail.then(() => {
        if (queues.get(sessionId) === tail) queues.delete(sessionId);
      });
    }
    return result;
  }

  invalidate(reason: string): void {
    this.controller.abort(new InteractivePromptCancelledError(reason));
    this.controller = new AbortController();
  }
}

function rejectWhenAborted<T>(
  interaction: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(cancellationError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    interaction.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- preserve the interaction's original rejection
        reject(error);
      },
    );
  });
}

function cancellationError(
  signal: AbortSignal,
): InteractivePromptCancelledError {
  return signal.reason instanceof InteractivePromptCancelledError
    ? signal.reason
    : new InteractivePromptCancelledError("Permission interaction cancelled.");
}
