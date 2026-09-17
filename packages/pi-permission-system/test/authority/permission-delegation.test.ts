import { describe, expect, it, vi } from "vitest";
import {
  type DelegationHandshake,
  type DelegationIdentity,
  isDelegationId,
  isDelegationRequired,
  PermissionDelegation,
} from "#src/authority/permission-delegation";

const identity: DelegationIdentity = {
  parentSessionId: "parent",
  childSessionId: "child",
  agentName: "worker",
  childCwd: "/work/child",
};

function makeRuntime(overrides?: { sessionId?: string; cwd?: string }) {
  return {
    getContext: () => ({
      cwd: overrides?.cwd ?? "/work/child",
      sessionManager: { getSessionId: () => overrides?.sessionId ?? "child" },
    }),
    canonicalizeCwd: (value: string) => value,
  };
}

function readyFor(value: DelegationIdentity, delegationId: string) {
  return {
    capability: "interactive-delegation-v1" as const,
    delegationId,
    parentSessionId: value.parentSessionId,
    childSessionId: value.childSessionId,
  };
}

function makeHandshake(
  implementation?: DelegationHandshake["connect"],
): DelegationHandshake {
  return {
    connect: vi.fn(implementation),
    discardBinding: vi.fn(),
    isBindingLive: () => true,
    getBindingSignal: () => undefined,
    close: vi.fn(),
  };
}

describe("delegation file IDs", () => {
  it.each(["binding-1", "a.b_c-2", "1", "a0"])("accepts %j", (value) => {
    expect(isDelegationId(value)).toBe(true);
  });
  it.each([
    undefined,
    null,
    1,
    "",
    ".",
    "..",
    "_binding",
    "-binding",
    "a/b",
    "a\\b",
  ])("rejects %j", (value) => {
    expect(isDelegationId(value)).toBe(false);
  });
});

describe("PermissionDelegation", () => {
  it("freezes initial and closed states", () => {
    const delegation = new PermissionDelegation(
      makeRuntime(),
      makeHandshake(),
      true,
    );
    expect(Object.isFrozen(delegation.getState())).toBe(true);
    delegation.close();
    expect(Object.isFrozen(delegation.getState())).toBe(true);
  });

  it("revalidates a binding once without mutating prior ready snapshots", async () => {
    let live = true;
    const handshake = makeHandshake(async (value, id) => readyFor(value, id));
    handshake.isBindingLive = vi.fn(() => live);
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);
    await delegation.connect(identity);
    const binding = delegation.getBinding()!;
    const ready = delegation.getState();
    vi.mocked(handshake.isBindingLive).mockClear();
    expect(binding.isLive()).toBe(true);
    expect(handshake.isBindingLive).toHaveBeenCalledOnce();
    live = false;
    expect(binding.isLive()).toBe(false);
    expect(handshake.isBindingLive).toHaveBeenCalledTimes(2);
    expect(ready.status).toBe("ready");
    expect(Object.isFrozen(ready)).toBe(true);
    expect(delegation.getState().status).toBe("unavailable");
    expect(Object.isFrozen(delegation.getState())).toBe(true);
    delegation.close();
  });

  it("lets the abort listener own invalidation detected by a live recheck", async () => {
    const controller = new AbortController();
    let live = true;
    let listenerState: ReturnType<PermissionDelegation["getState"]> | undefined;
    const handshake: DelegationHandshake = {
      discardBinding: vi.fn(),
      close: vi.fn(),
      connect: async (value, id) => readyFor(value, id),
      getBindingSignal: () => controller.signal,
      isBindingLive: () => {
        if (live) return true;
        controller.abort();
        listenerState = delegation.getState();
        return false;
      },
    };
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);
    await delegation.connect(identity);
    live = false;
    const state = delegation.getState();
    expect(state.status).toBe("unavailable");
    expect(state).toBe(listenerState);
    delegation.close();
  });

  it("publishes immutable, independent waits and clears them before disposing observers", async () => {
    const delegation = new PermissionDelegation(
      makeRuntime(),
      makeHandshake(async (value, id) => readyFor(value, id)),
      true,
    );
    await delegation.connect(identity);
    const seen = vi.fn();
    delegation.subscribeWaits(() => {
      throw new Error("observer failure");
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Deliberately exercise an async observer's ignored rejection.
    delegation.subscribeWaits(async () => {
      throw new Error("async observer failure");
    });
    const unsubscribe = delegation.subscribeWaits(seen);
    expect(seen).toHaveBeenLastCalledWith([]);
    const binding = delegation.getBinding()!;
    const endFirst = binding.beginWait("first");
    const endSecond = binding.beginWait("second");
    const snapshot = seen.mock.calls.at(-1)![0];
    expect(snapshot).toEqual([
      {
        delegationId: binding.delegationId,
        childSessionId: "child",
        requestId: "first",
      },
      {
        delegationId: binding.delegationId,
        childSessionId: "child",
        requestId: "second",
      },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    const late = vi.fn();
    delegation.subscribeWaits(late);
    expect(late).toHaveBeenLastCalledWith(snapshot);
    endFirst();
    expect(seen).toHaveBeenLastCalledWith([snapshot[1]]);
    const count = seen.mock.calls.length;
    endFirst();
    expect(seen).toHaveBeenCalledTimes(count);
    delegation.close();
    expect(seen).toHaveBeenLastCalledWith([]);
    expect(binding.signal.aborted).toBe(true);
    endSecond();
    expect(seen).toHaveBeenCalledTimes(count + 1);
    unsubscribe();
    unsubscribe();
    await Promise.resolve();
  });

  it("rejects an invalid requirement marker during startup", () => {
    expect(() =>
      isDelegationRequired({ PI_PERMISSION_DELEGATION_REQUIRED: "yes" }),
    ).toThrow(
      'PI_PERMISSION_DELEGATION_REQUIRED must be "1" or unset; received "yes"',
    );
    expect(isDelegationRequired({})).toBe(false);
    expect(
      isDelegationRequired({ PI_PERMISSION_DELEGATION_REQUIRED: "1" }),
    ).toBe(true);
  });

  it.each([
    ["parentSessionId", ""],
    ["childSessionId", "other"],
    ["parentSessionId", "child"],
    ["parentSessionId", "unknown"],
    ["childCwd", "/other"],
  ] as const)("rejects invalid %s=%j before handshaking", async (field, value) => {
    const handshake = makeHandshake();
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);
    await expect(
      delegation.connect({ ...identity, [field]: value }),
    ).rejects.toMatchObject({ code: "invalid_identity" });
    expect(handshake.connect).not.toHaveBeenCalled();
  });

  it("shares an identical in-flight connection and rejects conflicting identity", async () => {
    let delegationId = "";
    let resolveHandshake: (value: ReturnType<typeof readyFor>) => void = () =>
      undefined;
    const handshake = makeHandshake(
      (value, receivedDelegationId) =>
        new Promise((resolve) => {
          delegationId = receivedDelegationId;
          resolveHandshake = resolve;
          void value;
        }),
    );
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);

    const first = delegation.connect(identity);
    const duplicate = delegation.connect({ ...identity });
    expect(duplicate).toBe(first);
    await expect(
      delegation.connect({ ...identity, agentName: "other" }),
    ).rejects.toMatchObject({ code: "conflicting_identity" });

    resolveHandshake(readyFor(identity, delegationId));
    await expect(first).resolves.toMatchObject({ parentSessionId: "parent" });
    expect(delegation.getState()).toMatchObject({
      status: "ready",
      identity,
    });
    await expect(delegation.connect({ ...identity })).resolves.toEqual(
      readyFor(identity, delegationId),
    );
  });

  it("rejects mismatched acknowledgements and requires an explicit retry", async () => {
    const handshake = makeHandshake(async (value, delegationId) => ({
      ...readyFor(value, delegationId),
      parentSessionId: "other",
    }));
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);

    await expect(delegation.connect(identity)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(delegation.getState()).toMatchObject({ status: "unavailable" });

    vi.mocked(handshake.connect).mockImplementationOnce(async (value, id) =>
      readyFor(value, id),
    );
    await expect(delegation.connect(identity)).resolves.toMatchObject({
      childSessionId: "child",
    });
  });

  it("rejects retargeting after a failed connection while retaining the failed identity", async () => {
    const failure = new Error("parent unavailable");
    const handshake = makeHandshake(async () => {
      throw failure;
    });
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);
    await expect(delegation.connect(identity)).rejects.toMatchObject({
      code: "unavailable",
      cause: failure,
    });
    const failed = delegation.getState();
    expect(failed).toEqual({
      status: "unavailable",
      code: "unavailable",
      identity,
      delegationId: expect.any(String),
    });
    await expect(
      delegation.connect({ ...identity, parentSessionId: "different-parent" }),
    ).rejects.toMatchObject({ code: "conflicting_identity" });
    expect(handshake.connect).toHaveBeenCalledOnce();
    expect(delegation.getState()).toBe(failed);
  });

  it("never lets a stale service become ready after close", async () => {
    const entered = Promise.withResolvers<string>();
    const release = Promise.withResolvers<ReturnType<typeof readyFor>>();
    const handshake = makeHandshake((_value, delegationId) => {
      entered.resolve(delegationId);
      return release.promise;
    });
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);

    const connection = delegation.connect(identity);
    const delegationId = await entered.promise;
    expect(handshake.connect).toHaveBeenCalledOnce();
    delegation.close();
    release.resolve(readyFor(identity, delegationId));

    await expect(connection).rejects.toMatchObject({ code: "closed" });
    expect(delegation.getState()).toEqual({ status: "closed", code: "closed" });
    await expect(delegation.connect(identity)).rejects.toMatchObject({
      code: "closed",
    });
  });

  it("rejects readiness when the binding signal already aborted", async () => {
    const binding = new AbortController();
    binding.abort();
    const handshake = makeHandshake(async (value, id) => readyFor(value, id));
    handshake.getBindingSignal = () => binding.signal;
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);

    await expect(delegation.connect(identity)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(delegation.getState()).toMatchObject({ status: "unavailable" });
    const attemptedId = vi.mocked(handshake.connect).mock.calls[0][1];
    expect(handshake.discardBinding).toHaveBeenCalledExactlyOnceWith(
      attemptedId,
    );
  });

  it("invalidates a ready binding when its negotiated liveness signal aborts", async () => {
    const binding = new AbortController();
    const handshake = makeHandshake(async (value, id) => readyFor(value, id));
    handshake.getBindingSignal = () => binding.signal;
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);

    await delegation.connect(identity);
    binding.abort();

    expect(delegation.getState()).toMatchObject({
      status: "unavailable",
      code: "unavailable",
      identity,
    });
  });

  it("recovers from a synchronous handshake failure and leaves snapshots immutable", async () => {
    const handshake = makeHandshake(() => {
      throw new Error("offline");
    });
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);

    await expect(delegation.connect(identity)).rejects.toMatchObject({
      code: "unavailable",
    });
    const unavailable = delegation.getState();
    expect(Object.isFrozen(unavailable)).toBe(true);
    if (unavailable.status !== "unavailable")
      throw new Error("Expected unavailable state");
    expect(Object.isFrozen(unavailable.identity)).toBe(true);

    vi.mocked(handshake.connect).mockImplementationOnce(async (value, id) =>
      readyFor(value, id),
    );
    await expect(delegation.connect(identity)).resolves.toMatchObject({
      delegationId: expect.any(String),
    });
  });

  it("rejects a pre-aborted call without starting a handshake", async () => {
    const handshake = makeHandshake(async (value, delegationId) =>
      readyFor(value, delegationId),
    );
    const delegation = new PermissionDelegation(makeRuntime(), handshake, true);
    const controller = new AbortController();
    controller.abort();

    await expect(
      delegation.connect(identity, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(delegation.getState()).toEqual({ status: "unbound" });
    expect(handshake.connect).not.toHaveBeenCalled();
  });

  it("does not connect optional sessions", async () => {
    const handshake = makeHandshake();
    const delegation = new PermissionDelegation(
      makeRuntime(),
      handshake,
      false,
    );

    expect(delegation.getState()).toEqual({ status: "not-required" });
    await expect(delegation.connect(identity)).rejects.toMatchObject({
      code: "not_required",
    });
    expect(handshake.connect).not.toHaveBeenCalled();
  });
});
