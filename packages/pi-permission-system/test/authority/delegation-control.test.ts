import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DelegationControlClient,
  DelegationControlServer,
} from "#src/authority/delegation-control";
import * as forwardingIo from "#src/authority/forwarding-io";
import {
  SERVING_HEARTBEAT_REFRESH_MS,
  ServingHeartbeatStore,
  servingHeartbeatPath,
} from "#src/authority/forwarding-liveness";
import {
  type DelegationReady,
  PermissionDelegation,
} from "#src/authority/permission-delegation";
import { encodeSessionIdForPath } from "#src/authority/permission-forwarding";
import {
  createForwardingTempDir,
  type ForwardingTempDir,
  makeForwarderContext,
} from "#test/helpers/forwarding-fixtures";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

let temp: ForwardingTempDir | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  temp?.cleanup();
  temp = undefined;
});

const identity = {
  parentSessionId: "parent",
  childSessionId: "child",
  agentName: "worker",
  childCwd: "/child",
};

function setup(timeoutMs?: () => number) {
  temp = createForwardingTempDir("parent");
  const logger = { review: vi.fn(), debug: vi.fn() };
  const heartbeats = new ServingHeartbeatStore({
    forwardingDir: temp.forwardingDir,
    logger,
    capabilities: ["interactive-delegation-v1"],
    isProcessAlive: () => true,
  });
  heartbeats.markServing("parent");
  const server = new DelegationControlServer({
    forwardingDir: temp.forwardingDir,
    logger,
    canServe: () => true,
    isProcessAlive: () => true,
  });
  const client = new DelegationControlClient({
    forwardingDir: temp.forwardingDir,
    logger,
    heartbeats,
    pid: 123,
    timeoutMs,
  });
  return { client, heartbeats, logger, server, temp };
}

function connectChild(
  client: DelegationControlClient,
  id: string,
  signal = new AbortController().signal,
) {
  return client.connect(identity, id, { signal });
}

async function admitChild(
  client: DelegationControlClient,
  server: DelegationControlServer,
  id: string,
) {
  const connecting = connectChild(client, id);
  server.process(parentContext());
  await vi.advanceTimersByTimeAsync(250);
  return connecting;
}

function controlPath(
  forwardingDir: string,
  kind: "requests" | "children" | "responses" | "revocations",
  delegationId: string,
): string {
  return join(
    forwardingDir,
    "delegations",
    encodeSessionIdForPath("parent"),
    kind,
    `${delegationId}.json`,
  );
}

function requestPath(forwardingDir: string, delegationId: string): string {
  return controlPath(forwardingDir, "requests", delegationId);
}

function requestExists(temp: ForwardingTempDir, id: string): boolean {
  return fs.existsSync(requestPath(temp.forwardingDir, id));
}

function readResponse(
  temp: ForwardingTempDir,
  id: string,
): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(controlPath(temp.forwardingDir, "responses", id), "utf8"),
  ) as Record<string, unknown>;
}

function publishControlFile(
  path: string,
  value: Record<string, unknown>,
): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value));
}

function publishRequest(
  forwardingDir: string,
  delegationId: string,
  requestIdentity = identity,
): void {
  publishControlFile(requestPath(forwardingDir, delegationId), {
    capability: "interactive-delegation-v1",
    delegationId,
    identity: requestIdentity,
  });
}

const parentContext = () =>
  makeForwarderContext({ hasUI: true, sessionId: "parent" });

function makeDelegation(client: DelegationControlClient) {
  return new PermissionDelegation(
    {
      getContext: () => ({
        cwd: identity.childCwd,
        sessionManager: { getSessionId: () => identity.childSessionId },
      }),
      canonicalizeCwd: (value) => value,
    },
    client,
    true,
  );
}

async function startPendingDelegation(client: DelegationControlClient) {
  const delegation = makeDelegation(client);
  const controller = new AbortController();
  const result = delegation
    .connect(identity, { signal: controller.signal })
    .catch((error: unknown) => error);
  await Promise.resolve();
  const state = delegation.getState();
  if (state.status !== "connecting")
    throw new Error("Expected a pending handshake");
  const signal = client.getBindingSignal(state.delegationId);
  if (!signal) throw new Error("Expected child liveness before ACK");
  return {
    delegation,
    controller,
    result,
    delegationId: state.delegationId,
    signal,
  };
}

function expectBindingDiscarded(
  client: DelegationControlClient,
  delegationId: string,
  signal: AbortSignal,
): void {
  expect(signal.aborted).toBe(true);
  expect(client.getBindingSignal(delegationId)).toBeUndefined();
}

async function holdAdmission(
  client: DelegationControlClient,
  server: DelegationControlServer,
) {
  const admitted = Promise.withResolvers<DelegationReady>();
  const release = Promise.withResolvers<undefined>();
  const connect = client.connect.bind(client);
  vi.spyOn(client, "connect").mockImplementationOnce(async (...args) => {
    const ready = await connect(...args);
    admitted.resolve(ready);
    await release.promise;
    return ready;
  });
  const delegation = makeDelegation(client);
  const controller = new AbortController();
  const connection = delegation.connect(identity, {
    signal: controller.signal,
  });
  await Promise.resolve();
  server.process(parentContext());
  await vi.advanceTimersByTimeAsync(250);
  const ready = await admitted.promise;
  return { delegation, controller, connection, release, ready };
}

async function abortAndAwait(
  admission: Awaited<ReturnType<typeof holdAdmission>>,
  trigger: () => void,
  code: "cancelled" | "closed",
): Promise<void> {
  const rejected = expect(admission.connection).rejects.toMatchObject({ code });
  trigger();
  admission.release.resolve(undefined);
  await rejected;
}

describe("DelegationControl", () => {
  it("rejects capability advertised by another identity at the parent's heartbeat path", async () => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    const heartbeatPath = servingHeartbeatPath(
      currentTemp.forwardingDir,
      "parent",
    );
    const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
    fs.writeFileSync(
      heartbeatPath,
      JSON.stringify({ ...heartbeat, sessionId: "foreign-parent" }),
    );
    const result = connectChild(client, "foreign-heartbeat").catch(
      (error: unknown) => error,
    );
    try {
      server.process(parentContext());
      await vi.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toEqual(
        new Error(
          "Delegation parent is unavailable or does not support the capability",
        ),
      );
      expect(client.getBindingSignal("foreign-heartbeat")).toBeUndefined();
      expect(requestExists(currentTemp, "foreign-heartbeat")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.close();
      await result;
    }
  });

  it.each([
    [".", "%2E"],
    ["..", "%2E%2E"],
  ])("isolates delegation for whitespace-padded parent %j", async (parentSessionId, encoded) => {
    vi.useFakeTimers();
    const { client, server, heartbeats, temp: currentTemp } = setup();
    heartbeats.markServing(parentSessionId);
    const delegation = makeDelegation(client);
    const result = delegation
      .connect({
        ...identity,
        parentSessionId: ` \t${parentSessionId}\n `,
        childSessionId: " child ",
      })
      .catch((error: unknown) => error);
    try {
      await Promise.resolve();
      const state = delegation.getState();
      if (state.status !== "connecting")
        throw new Error("Expected a pending handshake");
      const root = join(currentTemp.forwardingDir, "delegations");
      expect(fs.readdirSync(root)).toEqual([encoded]);
      expect(
        fs.existsSync(
          join(root, encoded, "requests", `${state.delegationId}.json`),
        ),
      ).toBe(true);
      server.process(
        makeForwarderContext({
          hasUI: true,
          sessionId: ` ${parentSessionId} `,
        }),
      );
      await vi.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toEqual({
        capability: "interactive-delegation-v1",
        delegationId: state.delegationId,
        parentSessionId,
        childSessionId: identity.childSessionId,
      });
      expect(
        server.isBindingLive(state.delegationId, {
          ...identity,
          parentSessionId,
        }),
      ).toBe(true);
      expect(fs.existsSync(join(currentTemp.forwardingDir, "requests"))).toBe(
        false,
      );
      expect(fs.existsSync(join(root, "requests"))).toBe(false);
    } finally {
      delegation.close();
      await result;
    }
  });

  it.each([
    "refresh failure",
    "revocation",
  ])("ends a pending handshake immediately after %s", async (loss) => {
    vi.useFakeTimers();
    const { client, heartbeats, temp: currentTemp } = setup();
    // Hold the poll itself: rejection must come from binding loss, not a subsequent poll.
    const poll = Promise.withResolvers<undefined>();
    vi.spyOn(forwardingIo, "sleep").mockReturnValueOnce(poll.promise);
    const pending = await startPendingDelegation(client);
    const { delegation, delegationId, signal, result } = pending;
    const heartbeat = controlPath(
      currentTemp.forwardingDir,
      "children",
      delegationId,
    );
    try {
      expect(requestExists(currentTemp, delegationId)).toBe(true);
      if (loss === "revocation") {
        publishControlFile(
          controlPath(currentTemp.forwardingDir, "revocations", delegationId),
          {
            delegationId,
            childSessionId: identity.childSessionId,
          },
        );
      } else {
        vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
          throw new Error("refresh failed");
        });
      }
      await vi.advanceTimersByTimeAsync(SERVING_HEARTBEAT_REFRESH_MS);
      expect(heartbeats.getLiveHeartbeat("parent")?.capabilities).toContain(
        "interactive-delegation-v1",
      );
      expect(delegation.getState()).toEqual({
        status: "unavailable",
        code: "unavailable",
        identity,
        delegationId,
      });
      await expect(result).resolves.toMatchObject({ code: "unavailable" });
      expectBindingDiscarded(client, delegationId, signal);
      expect(requestExists(currentTemp, delegationId)).toBe(false);
      expect(fs.existsSync(heartbeat)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(SERVING_HEARTBEAT_REFRESH_MS);
      expect(fs.existsSync(heartbeat)).toBe(false);
    } finally {
      delegation.close();
      poll.resolve(undefined);
      await result;
    }
  });

  it("rejects a late matching ACK even when retirement cannot publish its tombstone", async () => {
    vi.useFakeTimers();
    const { client, logger, temp: currentTemp } = setup();
    const { delegation, delegationId, signal, result } =
      await startPendingDelegation(client);
    try {
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw new Error("revocation failed");
      });
      client.discardBinding(delegationId);
      publishControlFile(
        controlPath(currentTemp.forwardingDir, "responses", delegationId),
        {
          capability: "interactive-delegation-v1",
          delegationId,
          parentSessionId: identity.parentSessionId,
          childSessionId: identity.childSessionId,
          identity,
          accepted: true,
        },
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(delegation.getState()).toEqual({
        status: "unavailable",
        code: "unavailable",
        identity,
        delegationId,
      });
      await expect(result).resolves.toMatchObject({ code: "unavailable" });
      expectBindingDiscarded(client, delegationId, signal);
      expect(logger.review).toHaveBeenCalledWith(
        "permission_forwarding.warning",
        {
          message: `Failed to revoke delegation '${delegationId}'`,
          error: "revocation failed",
        },
      );
    } finally {
      delegation.close();
      await result;
    }
  });

  it("allows explicit retry after pre-ACK loss without old cleanup retiring it", async () => {
    vi.useFakeTimers();
    const { client, server } = setup();
    const { delegation, delegationId, result } =
      await startPendingDelegation(client);
    try {
      client.discardBinding(delegationId);
      await vi.advanceTimersByTimeAsync(0);
      expect(delegation.getState().status).toBe("unavailable");
      await expect(result).resolves.toMatchObject({ code: "unavailable" });
      const retry = delegation.connect(identity);
      await Promise.resolve();
      server.process(parentContext());
      await vi.advanceTimersByTimeAsync(250);
      const ready = await retry;
      expect(ready.delegationId).not.toBe(delegationId);
      client.discardBinding(delegationId);
      client.discardBinding(delegationId);
      expect(delegation.getState().status).toBe("ready");
      expect(server.isBindingLive(ready.delegationId, identity)).toBe(true);
      expect(client.getBindingSignal(ready.delegationId)?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      delegation.close();
      await result;
    }
  });

  it.each([
    "cancelled",
    "closed",
  ])("preserves %s for an interrupted pre-ACK lifecycle", async (code) => {
    vi.useFakeTimers();
    const { client, temp: currentTemp } = setup();
    const { delegation, controller, delegationId, signal, result } =
      await startPendingDelegation(client);
    try {
      if (code === "closed") delegation.close();
      else controller.abort();
      await expect(result).resolves.toMatchObject({ code });
      expect(delegation.getState()).toEqual(
        code === "closed"
          ? { status: "closed", code }
          : { status: "unavailable", code, identity, delegationId },
      );
      expectBindingDiscarded(client, delegationId, signal);
      expect(requestExists(currentTemp, delegationId)).toBe(false);
    } finally {
      delegation.close();
      await result;
    }
  });

  it.each([
    0, 2,
  ])("checks revocations for only %i current bindings, never history", async (count) => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    const ids = count === 0 ? [] : ["kept", "revoked"];
    const connecting = Promise.all(ids.map((id) => connectChild(client, id)));
    fs.mkdirSync(dirname(requestPath(currentTemp.forwardingDir, "unused")), {
      recursive: true,
    });
    server.process(parentContext());
    await vi.advanceTimersByTimeAsync(250);
    await connecting;
    const history = ["old-a", "old-b", "old-c"].map((id) => {
      const path = controlPath(currentTemp.forwardingDir, "revocations", id);
      publishControlFile(path, {
        delegationId: id,
        childSessionId: "old-child",
      });
      return { path, content: fs.readFileSync(path, "utf8") };
    });
    const revokedPath = controlPath(
      currentTemp.forwardingDir,
      "revocations",
      "revoked",
    );
    publishControlFile(revokedPath, {
      delegationId: "revoked",
      childSessionId: "child",
    });
    const listing = vi.spyOn(fs, "readdirSync");
    const reads = vi.spyOn(fs, "readFileSync");
    server.process(parentContext());
    expect(listing).not.toHaveBeenCalledWith(dirname(revokedPath));
    const revocationReads = reads.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith(dirname(revokedPath)));
    expect(revocationReads).toEqual(
      ids.map((id) =>
        controlPath(currentTemp.forwardingDir, "revocations", id),
      ),
    );
    expect(server.isBindingLive("revoked", identity)).toBe(false);
    expect(server.isBindingLive("kept", identity)).toBe(count > 0);
    for (const { path, content } of history)
      expect(fs.readFileSync(path, "utf8")).toBe(content);
    expect(JSON.parse(fs.readFileSync(revokedPath, "utf8"))).toEqual({
      delegationId: "revoked",
      childSessionId: "child",
    });
    client.close();
  });

  it.each([
    "delegationId",
    "childSessionId",
  ] as const)("does not retire a binding for a revocation with a foreign %s", async (field) => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    await admitChild(client, server, "current");
    const path = controlPath(
      currentTemp.forwardingDir,
      "revocations",
      "current",
    );
    publishControlFile(path, {
      delegationId: "current",
      childSessionId: "child",
      [field]: "foreign",
    });
    server.process(parentContext());
    // Presence fails closed while visible, but a foreign tuple must not delete the admission.
    expect(server.isBindingLive("current", identity)).toBe(false);
    fs.rmSync(path);
    expect(server.isBindingLive("current", identity)).toBe(true);
    client.close();
  });

  it("preserves an accepted acknowledgement across failed request deletion and delayed pickup", async () => {
    vi.useFakeTimers();
    const { client, server, logger, temp: currentTemp } = setup();
    const connecting = connectChild(client, "sticky-request");
    const request = requestPath(currentTemp.forwardingDir, "sticky-request");
    const response = controlPath(
      currentTemp.forwardingDir,
      "responses",
      "sticky-request",
    );
    const unlink = fs.unlinkSync;
    let canDelete = false;
    vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path) === request && !canDelete)
        throw new Error("unlink failed");
      unlink(path);
    });
    server.process(parentContext());
    const accepted = fs.readFileSync(response, "utf8");
    expect(JSON.parse(accepted).accepted).toBe(true);
    expect(logger.review).toHaveBeenCalledWith(
      "permission_forwarding.warning",
      {
        message: `Failed to delete delegation request file '${request}'`,
        error: "unlink failed",
      },
    );
    server.process(parentContext());
    expect(fs.readFileSync(response, "utf8")).toBe(accepted);
    expect(fs.existsSync(request)).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await expect(connecting).resolves.toMatchObject({
      delegationId: "sticky-request",
    });
    canDelete = true;
    server.process(parentContext());
    expect(fs.existsSync(request)).toBe(false);
    expect(fs.readFileSync(response, "utf8")).toBe(accepted);
    expect(server.isBindingLive("sticky-request", identity)).toBe(true);
    client.close();
  });

  it.each([
    "foreign identity",
    "revoked",
    "dead",
  ])("does not reuse acknowledgement for a %s binding", async (caseName) => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    await admitChild(client, server, "replayed");
    const replayIdentity =
      caseName === "foreign identity"
        ? { ...identity, agentName: "other" }
        : identity;
    if (caseName === "revoked") server.revokeAll();
    if (caseName === "dead")
      fs.rmSync(controlPath(currentTemp.forwardingDir, "children", "replayed"));
    publishRequest(currentTemp.forwardingDir, "replayed", replayIdentity);
    server.process(parentContext());
    const response = readResponse(currentTemp, "replayed");
    expect(response).toEqual({
      capability: "interactive-delegation-v1",
      delegationId: "replayed",
      parentSessionId: "parent",
      childSessionId: "child",
      identity: replayIdentity,
      accepted: false,
    });
    expect(server.isBindingLive("replayed", replayIdentity)).toBe(false);
    expect(server.isBindingLive("replayed", identity)).toBe(
      caseName === "foreign identity",
    );
    client.close();
  });

  it.each([
    "rejected",
    "corrupt",
  ])("does not reuse a %s acknowledgement for a still-live binding", async (kind) => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    await admitChild(client, server, "rejected-ack");
    const response = controlPath(
      currentTemp.forwardingDir,
      "responses",
      "rejected-ack",
    );
    const rejectedAck = {
      ...readResponse(currentTemp, "rejected-ack"),
      accepted: false,
    };
    if (kind === "corrupt") fs.writeFileSync(response, "{not-json");
    else publishControlFile(response, rejectedAck);
    publishRequest(currentTemp.forwardingDir, "rejected-ack");
    expect(server.isBindingLive("rejected-ack", identity)).toBe(true);
    const publish = vi.spyOn(fs, "renameSync");

    server.process(parentContext());

    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      response,
    );
    expect(server.isBindingLive("rejected-ack", identity)).toBe(true);
    expect(readResponse(currentTemp, "rejected-ack")).toEqual(rejectedAck);
    expect(requestExists(currentTemp, "rejected-ack")).toBe(false);
    client.close();
  });

  it("disposes a real admission cancelled before upper readiness validation", async () => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    const admission = await holdAdmission(client, server);
    const { delegation, controller, ready } = admission;
    const signal = client.getBindingSignal(ready.delegationId)!;
    const dispose = vi.spyOn(client, "discardBinding");
    expect(server.isBindingLive(ready.delegationId, identity)).toBe(true);
    await abortAndAwait(admission, () => controller.abort(), "cancelled");
    expect(delegation.getState()).toEqual({
      status: "unavailable",
      code: "cancelled",
      identity,
      delegationId: ready.delegationId,
    });
    expect(client.getBindingSignal(ready.delegationId)).toBeUndefined();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(ready.delegationId);
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      fs.existsSync(
        controlPath(currentTemp.forwardingDir, "children", ready.delegationId),
      ),
    ).toBe(false);
    server.process(parentContext());
    expect(server.isBindingLive(ready.delegationId, identity)).toBe(false);
    delegation.close();
  });

  it("keeps a fresh retry live after late cleanup of a rejected admission", async () => {
    vi.useFakeTimers();
    const { client, server } = setup();
    const admission = await holdAdmission(client, server);
    const { delegation, controller, ready } = admission;
    await abortAndAwait(admission, () => controller.abort(), "cancelled");
    const retry = delegation.connect(identity);
    await Promise.resolve();
    server.process(parentContext());
    await vi.advanceTimersByTimeAsync(250);
    const replacement = await retry;
    expect(replacement.delegationId).not.toBe(ready.delegationId);
    client.discardBinding(ready.delegationId);
    client.discardBinding(ready.delegationId);
    expect(delegation.getState().status).toBe("ready");
    expect(client.getBindingSignal(replacement.delegationId)?.aborted).toBe(
      false,
    );
    expect(server.isBindingLive(replacement.delegationId, identity)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    delegation.close();
  });

  it("stays closed when teardown interrupts the admitted-to-ready boundary", async () => {
    vi.useFakeTimers();
    const { client, server } = setup();
    const admission = await holdAdmission(client, server);
    const { delegation, ready } = admission;
    await abortAndAwait(admission, () => delegation.close(), "closed");
    expect(delegation.getState()).toEqual({ status: "closed", code: "closed" });
    expect(client.getBindingSignal(ready.delegationId)).toBeUndefined();
    expect(server.isBindingLive(ready.delegationId, identity)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "parent loss",
    "revocation",
    "refresh failure",
  ])("disposes active resources after %s", async (loss) => {
    vi.useFakeTimers();
    const { client, server, heartbeats, logger, temp: currentTemp } = setup();
    await admitChild(client, server, "retired");
    const signal = client.getBindingSignal("retired")!;
    const heartbeat = controlPath(
      currentTemp.forwardingDir,
      "children",
      "retired",
    );
    if (loss === "parent loss") heartbeats.clearServing("parent");
    else if (loss === "revocation") server.revokeAll();
    else
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw new Error("refresh failed");
      });
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal.aborted).toBe(true);
    expect(client.getBindingSignal("retired")).toBeUndefined();
    expect(fs.existsSync(heartbeat)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    if (loss === "refresh failure") {
      expect(logger.review).toHaveBeenCalledWith(
        "permission_forwarding.warning",
        {
          message: "Failed to publish child liveness for 'retired'",
          error: "refresh failed",
        },
      );
    }
    server.process(parentContext());
    expect(server.isBindingLive("retired", identity)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fs.existsSync(heartbeat)).toBe(false);
    client.close();
  });

  it.each([
    "matching",
    "delegationId",
    "childSessionId",
  ] as const)("preserves only a matching revocation during disposal (%s)", async (field) => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    await admitChild(client, server, "retired");
    const expected = { delegationId: "retired", childSessionId: "child" };
    const tombstone = { ...expected };
    if (field !== "matching") tombstone[field] = "foreign";
    const path = controlPath(
      currentTemp.forwardingDir,
      "revocations",
      "retired",
    );
    publishControlFile(path, tombstone);
    const publish = vi.spyOn(fs, "renameSync");

    await vi.advanceTimersByTimeAsync(1000);

    expect(publish).toHaveBeenCalledTimes(field === "matching" ? 0 : 1);
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual(expected);
    expect(client.getBindingSignal("retired")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("allows a fresh retry from an abort listener without retaining the old binding", async () => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    await admitChild(client, server, "old");
    const signal = client.getBindingSignal("old")!;
    let retry: ReturnType<typeof connectChild> | undefined;
    const onAbort = vi.fn(() => {
      const retired = {
        signal: client.getBindingSignal("old"),
        live: client.isBindingLive("old"),
      };
      retry = connectChild(client, "new");
      return retired;
    });
    signal.addEventListener("abort", onAbort);
    server.revokeAll();
    await vi.advanceTimersByTimeAsync(1000);
    server.process(parentContext());
    await vi.advanceTimersByTimeAsync(250);
    await expect(retry).resolves.toMatchObject({ delegationId: "new" });
    expect(onAbort).toHaveBeenCalledOnce();
    expect(onAbort).toHaveReturnedWith({ signal: undefined, live: false });
    expect(client.isBindingLive("old")).toBe(false);
    expect(client.isBindingLive("new")).toBe(true);
    expect(server.isBindingLive("new", identity)).toBe(true);
    expect(
      fs.existsSync(controlPath(currentTemp.forwardingDir, "children", "old")),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    client.close();
  });

  it.each([
    "server",
    "client",
  ] as const)("recreates the revocation directory during %s teardown", async (owner) => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    await admitChild(client, server, "revoke-directory");
    const directory = dirname(
      controlPath(currentTemp.forwardingDir, "revocations", "revoke-directory"),
    );
    fs.rmSync(directory, { recursive: true });
    if (owner === "server") server.revokeAll();
    else client.close();
    expect(
      JSON.parse(
        fs.readFileSync(join(directory, "revoke-directory.json"), "utf8"),
      ),
    ).toEqual({ delegationId: "revoke-directory", childSessionId: "child" });
    expect(server.isBindingLive("revoke-directory", identity)).toBe(false);
    client.close();
  });

  it("cancels a handshake without waiting for the next poll tick", async () => {
    vi.useFakeTimers();
    const { client, temp: currentTemp } = setup();
    const controller = new AbortController();
    const result = expect(
      connectChild(client, "cancel-now", controller.signal),
    ).rejects.toThrow("cancelled");
    controller.abort();
    await result;
    expect(client.getBindingSignal("cancel-now")).toBeUndefined();
    expect(requestExists(currentTemp, "cancel-now")).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("cleans up a no-response deadline without leaving a heartbeat timer", async () => {
    vi.useFakeTimers();
    const { client, temp: currentTemp } = setup(() => 500);
    const result = expect(connectChild(client, "deadline")).rejects.toThrow(
      "unavailable",
    );
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(requestExists(currentTemp, "deadline")).toBe(false);
    expect(
      fs.existsSync(
        controlPath(currentTemp.forwardingDir, "children", "deadline"),
      ),
    ).toBe(false);
    expect(client.getBindingSignal("deadline")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it.each([
    "..",
    "_binding",
    "a/b",
    "",
  ])("rejects an invalid ID before publishing anything (%j)", async (id) => {
    const { client, temp: currentTemp } = setup();
    await expect(connectChild(client, id)).rejects.toThrow("cancelled");
    expect(fs.existsSync(join(currentTemp.forwardingDir, "delegations"))).toBe(
      false,
    );
    client.close();
  });

  it("rejects pre-cancelled handshakes before publishing anything", async () => {
    const { client, temp: currentTemp } = setup();
    await expect(
      connectChild(client, "cancelled", AbortSignal.abort()),
    ).rejects.toThrow("cancelled");
    expect(fs.existsSync(join(currentTemp.forwardingDir, "delegations"))).toBe(
      false,
    );
    client.close();
  });

  it("rejects a missing parent heartbeat before publishing child liveness", async () => {
    const { client, heartbeats, temp: currentTemp } = setup();
    heartbeats.clearServing("parent");
    await expect(connectChild(client, "absent")).rejects.toThrow("unavailable");
    expect(fs.existsSync(join(currentTemp.forwardingDir, "delegations"))).toBe(
      false,
    );
    client.close();
  });

  it("fails closed when the first child heartbeat cannot be published", async () => {
    vi.useFakeTimers();
    const { client, temp: currentTemp } = setup();
    fs.mkdirSync(
      controlPath(currentTemp.forwardingDir, "children", "blocked"),
      {
        recursive: true,
      },
    );
    await expect(connectChild(client, "blocked")).rejects.toThrow(
      "child liveness is unavailable",
    );
    expect(requestExists(currentTemp, "blocked")).toBe(false);
    expect(client.getBindingSignal("blocked")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("cancels a ready binding when refreshing child liveness fails", async () => {
    vi.useFakeTimers();
    const { client, server, logger, temp: currentTemp } = setup();
    await admitChild(client, server, "heartbeat-loss");
    const signal = client.getBindingSignal("heartbeat-loss")!;
    const heartbeat = controlPath(
      currentTemp.forwardingDir,
      "children",
      "heartbeat-loss",
    );
    fs.rmSync(heartbeat);
    fs.mkdirSync(heartbeat);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal.aborted).toBe(true);
    expect(client.isBindingLive("heartbeat-loss")).toBe(false);
    expect(client.getBindingSignal("heartbeat-loss")).toBeUndefined();
    expect(server.isBindingLive("heartbeat-loss", identity)).toBe(false);
    expect(logger.review).toHaveBeenCalledWith(
      "permission_forwarding.warning",
      {
        message: `Failed to delete delegation child heartbeat file '${heartbeat}'`,
        error: expect.any(String),
      },
    );
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("rejects the consumed handshake promptly after acknowledgement publication recovers", async () => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    const result = expect(connectChild(client, "ack-loss")).rejects.toThrow(
      "rejected",
    );
    const response = controlPath(
      currentTemp.forwardingDir,
      "responses",
      "ack-loss",
    );
    fs.mkdirSync(response);
    server.process(parentContext());
    expect(server.isBindingLive("ack-loss", identity)).toBe(false);
    expect(requestExists(currentTemp, "ack-loss")).toBe(true);
    fs.rmSync(response, { recursive: true });
    server.process(parentContext());
    await vi.advanceTimersByTimeAsync(250);
    await result;
    expect(server.isBindingLive("ack-loss", identity)).toBe(false);
    expect(requestExists(currentTemp, "ack-loss")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("discards child liveness if publishing the handshake request fails", async () => {
    vi.useFakeTimers();
    const { client, temp: currentTemp } = setup();
    const request = requestPath(currentTemp.forwardingDir, "request-loss");
    fs.mkdirSync(request, { recursive: true });
    await expect(connectChild(client, "request-loss")).rejects.toThrow();
    expect(client.getBindingSignal("request-loss")).toBeUndefined();
    expect(
      fs.existsSync(
        controlPath(currentTemp.forwardingDir, "children", "request-loss"),
      ),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("binds an exact live parent capability without waiting for the human drain", async () => {
    const { client, server } = setup();
    const connecting = connectChild(client, "binding-1");

    server.process(parentContext());

    await expect(connecting).resolves.toEqual({
      capability: "interactive-delegation-v1",
      delegationId: "binding-1",
      parentSessionId: "parent",
      childSessionId: "child",
    });
    expect(server.isBindingLive("binding-1", identity)).toBe(true);
    client.close();
    server.process(parentContext());
    expect(server.isBindingLive("binding-1", identity)).toBe(false);
  });

  it("keeps an admitted binding live while the child delays ACK pickup", async () => {
    const { client, server } = setup();
    const connecting = connectChild(client, "binding-delayed");
    const context = parentContext();
    server.process(context);
    server.process(context);

    expect(server.isBindingLive("binding-delayed", identity)).toBe(true);
    await expect(connecting).resolves.toMatchObject({
      delegationId: "binding-delayed",
    });
    client.close();
  });

  it("rejects an ACK whose full identity tuple differs", async () => {
    const { client, server, temp: currentTemp } = setup();
    const connecting = connectChild(client, "binding-tuple");
    server.process(parentContext());
    const responsePath = controlPath(
      currentTemp.forwardingDir,
      "responses",
      "binding-tuple",
    );
    const response = readResponse(currentTemp, "binding-tuple");
    fs.writeFileSync(
      responsePath,
      JSON.stringify({
        ...response,
        identity: { ...identity, agentName: "other" },
      }),
    );

    await expect(connecting).rejects.toThrow("rejected");
    client.close();
  });

  it("rejects an ACK when the parent dies before it is consumed", async () => {
    const { client, heartbeats, server } = setup();
    const connecting = connectChild(client, "binding-dead-parent");
    server.process(parentContext());
    heartbeats.clearServing("parent");

    await expect(connecting).rejects.toThrow("unavailable");
    client.close();
  });

  it("invalidates a child binding when the parent revokes it", async () => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    await admitChild(client, server, "binding-revoke");

    const binding = client.getBindingSignal("binding-revoke");
    server.revokeAll();
    const replacement = new DelegationControlServer({
      forwardingDir: currentTemp.forwardingDir,
      logger: { review: vi.fn(), debug: vi.fn() },
      canServe: () => true,
    });
    replacement.process(parentContext());
    await vi.advanceTimersByTimeAsync(1000);

    expect(binding?.aborted).toBe(true);
    client.close();
  });

  it("removes a detected dead child binding and its heartbeat on client close", async () => {
    const { client, server, temp: currentTemp } = setup();
    const connecting = connectChild(client, "binding-live");
    server.process(parentContext());
    await connecting;
    const childHeartbeat = controlPath(
      currentTemp.forwardingDir,
      "children",
      "binding-live",
    );
    expect(fs.existsSync(childHeartbeat)).toBe(true);

    fs.writeFileSync(
      childHeartbeat,
      JSON.stringify({
        delegationId: "binding-live",
        childSessionId: "other-child",
        pid: 123,
        updatedAt: Date.now(),
      }),
    );
    server.process(parentContext());
    expect(server.isBindingLive("binding-live", identity)).toBe(false);

    client.close();
    expect(fs.existsSync(childHeartbeat)).toBe(false);
  });

  it("rejects a mismatched parent tuple even with a live child heartbeat", async () => {
    vi.useFakeTimers();
    const { client, server, temp: currentTemp } = setup();
    const result = expect(connectChild(client, "binding-1")).rejects.toThrow(
      "rejected",
    );
    publishRequest(currentTemp.forwardingDir, "binding-1", {
      ...identity,
      parentSessionId: "other",
    });
    server.process(parentContext());
    expect(readResponse(currentTemp, "binding-1").accepted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await result;
    client.close();
  });

  it("rejects replay of a consumed handshake after same-id parent replacement", async () => {
    vi.useFakeTimers();
    const { client, server, logger, temp: currentTemp } = setup();
    await admitChild(client, server, "binding-2");
    const replacement = new DelegationControlServer({
      forwardingDir: currentTemp.forwardingDir,
      logger,
      canServe: () => true,
      isProcessAlive: () => true,
    });
    publishRequest(currentTemp.forwardingDir, "binding-2");
    replacement.process(parentContext());
    expect(replacement.isBindingLive("binding-2", identity)).toBe(false);
    expect(readResponse(currentTemp, "binding-2").accepted).toBe(false);
    client.close();
  });

  it("does not admit a child when the parent cannot serve authority", () => {
    const { temp: currentTemp } = setup();
    const server = new DelegationControlServer({
      forwardingDir: currentTemp.forwardingDir,
      logger: { review: vi.fn(), debug: vi.fn() },
      canServe: () => false,
    });
    const path = requestPath(currentTemp.forwardingDir, "binding-3");
    publishRequest(currentTemp.forwardingDir, "binding-3");

    server.process(parentContext());
    expect(server.isBindingLive("binding-3", identity)).toBe(false);
    expect(fs.existsSync(path)).toBe(true);
  });
});
