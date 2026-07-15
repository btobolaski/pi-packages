export class InteractivePromptCancelledError extends Error {
  override readonly name = "InteractivePromptCancelledError";
}

export interface InteractivePromptQueue {
  run<T>(interaction: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface InteractivePromptQueueLifecycle {
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

  run<T>(interaction: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    const scheduled = this.tail.then(() => {
      if (signal.aborted) {
        throw cancellationError(signal);
      }
      return interaction(signal);
    });
    const result = rejectWhenAborted(scheduled, signal);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  invalidate(reason: string): void {
    this.controller.abort(new InteractivePromptCancelledError(reason));
    this.controller = new AbortController();
    this.tail = Promise.resolve();
  }
}

function rejectWhenAborted<T>(
  interaction: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(cancellationError(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(cancellationError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
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
