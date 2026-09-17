import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParentAuthorizer } from "#src/authority/approval-escalator";
import { DelegationControlClient } from "#src/authority/delegation-control";
import { ForwardedRequestServer } from "#src/authority/forwarded-request-server";
import {
  cancelledPermissionDecision,
  type DelegatedRequest,
  delegatedTerminalPath,
  publishDelegatedTerminal,
  readDelegatedTerminal,
  validateDelegatedDecision,
} from "#src/authority/forwarded-transaction";
import { readForwardedPermissionRequest } from "#src/authority/forwarding-io";
import {
  type PendingDelegatedWait,
  PermissionDelegation,
} from "#src/authority/permission-delegation";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import { FORWARDED_PERMISSION_TIMEOUT_DECISION } from "#src/authority/permission-forwarding";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import { GateRunner } from "#src/handlers/gates/runner";
import type { GateOutcome } from "#src/handlers/gates/types";
import { SessionApproval } from "#src/session-approval";
import { SessionRules } from "#src/session-rules";
import { DECIDED_BY_HUMAN } from "#test/helpers/decision-fixtures";
import { startDelegationProcess } from "#test/helpers/delegation-process";
import {
  createForwardingTempDir,
  type ForwardingTempDir,
  makeDelegationProcessParent,
  makeForwardedAccessIntent,
  makeForwarderContext,
  makeParentAuthorizerDeps,
  makeServerDeps,
} from "#test/helpers/forwarding-fixtures";
import { makeCheckResult } from "#test/helpers/handler-fixtures";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

const servingApproval: PermissionPromptDecision = {
  approved: true,
  state: "approved_for_serving_session",
  decidedBy: DECIDED_BY_HUMAN,
};
const childApproval: PermissionPromptDecision = {
  approved: true,
  state: "approved",
  decidedBy: DECIDED_BY_HUMAN,
};
let temp: ForwardingTempDir;
const disposeExchanges: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  temp = createForwardingTempDir("parent-session");
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposeExchanges.splice(0)) await dispose();
  vi.useRealTimers();
  temp.cleanup();
});

function requestFixture(): DelegatedRequest {
  const identity = {
    parentSessionId: "parent-session",
    childSessionId: "child-session",
    agentName: "Explore",
    childCwd: "/worktree/issue-42",
  };
  const request = temp.writeRequest({
    id: "req-delegated",
    createdAt: 1000,
    expiresAt: 2000,
    source: "tool_call",
    surface: "bash",
    value: "git status",
    accessIntent: makeForwardedAccessIntent(),
    sessionApproval: { surface: "bash", patterns: ["git *"] },
    delegation: {
      capability: "interactive-delegation-v1",
      requestId: "req-delegated",
      delegationId: "binding-1",
      identity,
      expiresAt: 2000,
    },
  });
  return request as DelegatedRequest;
}

function fixture(check = makeCheckResult({ state: "ask" })) {
  const request = requestFixture();
  const human = Promise.withResolvers<PermissionPromptDecision>();
  const escalate = vi.fn((_details: PromptPermissionDetails) => human.promise);
  const isBindingLive = vi.fn(() => true);
  const recordSessionApproval = vi.fn();
  const server = new ForwardedRequestServer(
    makeServerDeps({
      forwardingDir: temp.forwardingDir,
      escalator: { escalate },
      policy: { resolve: () => check },
      delegationControl: { isBindingLive },
      recorder: { recordSessionApproval },
    }),
  );
  const context = makeForwarderContext({
    hasUI: true,
    sessionId: "parent-session",
  });
  const path = delegatedTerminalPath(temp.forwardingDir, request);
  return {
    request,
    human,
    escalate,
    isBindingLive,
    recordSessionApproval,
    server,
    context,
    path,
  };
}

async function requesterFixture() {
  const parent = makeDelegationProcessParent(temp);
  const { identity, heartbeats, logger } = parent;
  const context = makeForwarderContext({
    hasUI: true,
    sessionId: identity.childSessionId,
    cwd: identity.childCwd,
  });
  const client = new DelegationControlClient({
    forwardingDir: temp.forwardingDir,
    logger,
    heartbeats,
  });
  const delegation = new PermissionDelegation(
    { getContext: () => context, canonicalizeCwd: (value) => value },
    client,
    true,
  );
  const pendingWork: Promise<unknown>[] = [];
  disposeExchanges.push(async () => {
    delegation.close();
    parent.stopServing();
    parent.human.resolve(cancelledPermissionDecision());
    await Promise.all(pendingWork);
  });
  function serve() {
    const processing = parent.server.processInbox(parent.context);
    pendingWork.push(processing);
    return processing;
  }
  const entered = Promise.withResolvers<undefined>();
  const connect = client.connect.bind(client);
  vi.spyOn(client, "connect").mockImplementationOnce((...args) => {
    const result = connect(...args);
    entered.resolve(undefined);
    return result;
  });
  const connecting = delegation.connect(identity);
  await entered.promise;
  parent.control.process(parent.context);
  await vi.advanceTimersByTimeAsync(250);
  await connecting;
  const readyBinding = delegation.getBinding();
  if (!readyBinding) throw new Error("Expected a real ready binding");
  const binding = readyBinding;
  let waits: readonly PendingDelegatedWait[] = [];
  delegation.subscribeWaits((pending) => {
    waits = pending;
  });
  const childGrants = new SessionRules();
  const authorizer = new ParentAuthorizer(
    context,
    makeParentAuthorizerDeps({
      forwardingDir: temp.forwardingDir,
      logger,
      delegation: binding,
      getTimeoutMs: () => 10000,
    }),
  );
  const review = logger.review.getMockImplementation();
  async function start(id: string) {
    const published = Promise.withResolvers<undefined>();
    logger.review.mockImplementation((event, details) => {
      review?.(event, details);
      if (
        event === "forwarded_permission.request_created" &&
        details?.requestId === id
      )
        published.resolve(undefined);
    });
    let decision: PermissionPromptDecision | undefined;
    let outcome: GateOutcome | undefined;
    let executions = 0;
    const runner = new GateRunner(
      { resolve: () => makeCheckResult({ state: "ask" }) },
      childGrants,
      {
        escalate: async (details) => {
          decision = await authorizer.authorize({ ...details, requestId: id });
          return decision;
        },
      },
      { writeReviewLog() {}, emitDecision() {} },
      () => false,
    );
    const pending = runner
      .run(
        {
          ...parent.config.gate,
          sessionApproval: SessionApproval.single("bash", "git *"),
        },
        identity.agentName,
        {
          signal: binding.signal,
          isActive: () => !binding.signal.aborted && binding.isLive(),
        },
      )
      .then((result) => {
        outcome = result;
        if (result.action === "allow") executions++;
        return result;
      });
    pendingWork.push(pending);
    await published.promise;
    const requestPath = join(temp.location.requestsDir, `${id}.json`);
    const request = readForwardedPermissionRequest(
      logger,
      requestPath,
    ) as DelegatedRequest;
    return {
      pending,
      request,
      requestPath,
      terminal: delegatedTerminalPath(temp.forwardingDir, request),
      outcome: () => outcome,
      decision: () => decision,
      executions: () => executions,
    };
  }
  return { ...parent, binding, childGrants, start, serve, waits: () => waits };
}

describe("requester abandonment", () => {
  it("ends a wait at the next observation after both server publications fail", async () => {
    const f = await requesterFixture();
    const call = await f.start("failed-publication");
    const link = fs.linkSync;
    const failed = vi
      .spyOn(fs, "linkSync")
      .mockImplementation((source, target) => {
        if (target === call.terminal)
          throw new Error("terminal storage unavailable");
        link(source, target);
      });
    const processing = f.serve();
    await f.prompt;
    f.human.resolve(servingApproval);
    await processing;
    const liveCheck = vi.spyOn(f.control, "isBindingLive");
    f.server.checkPending();
    expect(liveCheck).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(existsSync(call.requestPath)).toBe(false);
    expect(existsSync(call.terminal)).toBe(false);
    failed.mockRestore();
    await vi.advanceTimersByTimeAsync(250);
    expect(call.outcome()?.action).toBe("block");
    expect(call.decision()).toMatchObject({
      confirmationUnavailable: true,
      decidedBy: { kind: "unavailable" },
    });
    expect(call.decision()?.forwardingTimedOut).toBeUndefined();
    expect(call.executions()).toBe(0);
    expect(f.waits()).toEqual([]);
    expect(f.grants.getRuleset()).toEqual([]);
    expect(f.childGrants.getRuleset()).toEqual([]);
    expect(f.binding.isLive()).toBe(true);
    expect(vi.getTimerCount()).toBe(2); // Parent refresh and child heartbeat only, no request/deadline timer.
    expect(readDelegatedTerminal(call.terminal, call.request)).toEqual(
      call.decision(),
    );
  });

  it.each([
    0, 1, 2,
  ])("preserves a committed approval with %i earlier missing-terminal observations", async (misses) => {
    const f = await requesterFixture();
    const call = await f.start("approved");
    // Capture absence before allowing the parent to commit. Replay that one
    // observation (or both reads) to place publication in the requester's IO gap.
    const missing = existsSync(call.terminal);
    expect(missing).toBe(false);
    const processing = f.serve();
    await f.prompt;
    f.human.resolve(servingApproval);
    await processing;
    expect(existsSync(call.requestPath)).toBe(false);
    const exists = fs.existsSync;
    let remaining = misses;
    vi.spyOn(fs, "existsSync").mockImplementation((path) => {
      if (path === call.terminal && remaining > 0) {
        remaining--;
        return missing;
      }
      return exists(path);
    });
    const publications = vi.spyOn(fs, "linkSync");
    await vi.advanceTimersByTimeAsync(250);
    expect(call.outcome()).toEqual({ action: "allow" });
    expect(call.decision()).toEqual({
      ...childApproval,
      decidedBy: {
        kind: "forwarded",
        responderSessionId: f.identity.parentSessionId,
        decision: DECIDED_BY_HUMAN,
      },
    });
    expect(remaining).toBe(0);
    expect(publications).toHaveBeenCalledTimes(misses === 2 ? 1 : 0);
    expect(call.executions()).toBe(1);
    expect(f.grants.getRuleset()).toHaveLength(1);
    expect(f.childGrants.getRuleset()).toEqual([]);
    expect(f.waits()).toEqual([]);
    expect(readDelegatedTerminal(call.terminal, call.request)).toEqual(
      childApproval,
    );
  });

  it.each([
    "approved_for_serving_session",
    "approved_for_session",
  ] as const)("keeps an unavailable winner against late %s", async (state) => {
    const f = await requesterFixture();
    const call = await f.start("abandoned-before-approval");
    const processing = f.serve();
    await f.prompt;
    rmSync(call.requestPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.outcome()?.action).toBe("block");
    const winner = readDelegatedTerminal(call.terminal, call.request);
    expect(winner).toMatchObject({
      confirmationUnavailable: true,
      decidedBy: { kind: "unavailable" },
    });
    f.human.resolve({ ...servingApproval, state });
    await processing;
    expect(readDelegatedTerminal(call.terminal, call.request)).toEqual(winner);
    expect(call.executions()).toBe(0);
    expect(f.grants.getRuleset()).toEqual([]);
    expect(f.childGrants.getRuleset()).toEqual([]);
    expect(f.binding.isLive()).toBe(true);
  });

  it("clears only the abandoned wait and reuses the healthy binding", async () => {
    const f = await requesterFixture();
    const abandoned = await f.start("first");
    const sibling = await f.start("sibling");
    expect(f.waits().map((wait) => wait.requestId)).toEqual([
      "first",
      "sibling",
    ]);
    rmSync(abandoned.requestPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(abandoned.outcome()?.action).toBe("block");
    expect(f.waits().map((wait) => wait.requestId)).toEqual(["sibling"]);
    expect(sibling.outcome()).toBeUndefined();
    const processing = f.serve();
    await f.prompt;
    f.human.resolve(childApproval);
    await processing;
    await vi.advanceTimersByTimeAsync(250);
    expect(sibling.outcome()).toEqual({ action: "allow" });
    const subsequent = await f.start("subsequent");
    await f.serve();
    await vi.advanceTimersByTimeAsync(250);
    expect(subsequent.outcome()).toEqual({ action: "allow" });
    expect(f.waits()).toEqual([]);
    expect(f.binding.isLive()).toBe(true);
    expect(f.grants.getRuleset()).toEqual([]);
    expect(f.childGrants.getRuleset()).toEqual([]);
  });
});

describe("delegated transaction paths", () => {
  it.each([
    [".", "%2E"],
    ["..", "%2E%2E"],
  ])("contains the terminal for dot session %j", (parentSessionId, encoded) => {
    const request = requestFixture();
    request.targetSessionId = parentSessionId;
    request.delegation.identity.parentSessionId = parentSessionId;
    const path = delegatedTerminalPath(temp.forwardingDir, request);
    expect(path).toBe(
      join(
        temp.forwardingDir,
        "delegations",
        encoded,
        "transactions",
        "binding-1",
        "req-delegated.json",
      ),
    );
    expect(path).not.toBe(
      delegatedTerminalPath(temp.forwardingDir, {
        ...request,
        targetSessionId: encoded,
      }),
    );
    expect(publishDelegatedTerminal(path, request, childApproval)).toBe(true);
    expect(readDelegatedTerminal(path, request)).toEqual(childApproval);
    expect(
      JSON.parse(readFileSync(path, "utf8")).transaction.identity
        .parentSessionId,
    ).toBe(parentSessionId);
  });
});

describe("delegated settlement", () => {
  it.each([
    ["allow", "approved", true],
    ["deny", "denied", false],
  ] as const)("settles a recorded %s without a prompt or a new grant", async (state, decision, approved) => {
    const f = fixture(
      makeCheckResult({ state, matchedPattern: "git *", origin: "session" }),
    );
    await f.server.processInbox(f.context);
    expect(readDelegatedTerminal(f.path, f.request)).toEqual({
      approved,
      state: decision,
      decidedBy: {
        kind: "rule",
        surface: "bash",
        pattern: "git *",
        origin: "session",
      },
    });
    expect(f.escalate).not.toHaveBeenCalled();
    expect(f.recordSessionApproval).not.toHaveBeenCalled();
  });

  it("commits serving scope once, translates the wire, and does not replay its grant", async () => {
    const f = fixture();
    const processing = f.server.processInbox(f.context);
    f.human.resolve(servingApproval);
    await processing;
    expect(readDelegatedTerminal(f.path, f.request)).toEqual(childApproval);
    expect(f.recordSessionApproval).toHaveBeenCalledTimes(1);
    expect(f.recordSessionApproval.mock.calls[0]?.[0]).toMatchObject({
      surface: "bash",
      patterns: ["git *"],
    });
    expect(
      publishDelegatedTerminal(
        f.path,
        f.request,
        cancelledPermissionDecision(),
      ),
    ).toBe(false);
    mkdirSync(temp.location.requestsDir, { recursive: true });
    temp.writeRequest(f.request);
    await f.server.processInbox(f.context);
    expect(f.recordSessionApproval).toHaveBeenCalledTimes(1);
    expect(f.escalate).toHaveBeenCalledTimes(1);
    expect(readDelegatedTerminal(f.path, f.request)).toEqual(childApproval);
  });

  it.each([
    "cancel",
    "deleted",
    "dead binding",
    "shutdown",
  ] as const)("%s while UI is pending cancels without a grant or late approval", async (cause) => {
    const f = fixture();
    const lifetime = new AbortController();
    const processing = f.server.processInbox(f.context, lifetime.signal);
    await vi.advanceTimersByTimeAsync(0);
    const signal = f.escalate.mock.calls[0]?.[0].requestSignal;
    expect(signal?.aborted).toBe(false);
    if (cause === "cancel")
      publishDelegatedTerminal(
        f.path,
        f.request,
        cancelledPermissionDecision(),
      );
    if (cause === "deleted")
      rmSync(join(temp.location.requestsDir, `${f.request.id}.json`));
    if (cause === "dead binding") f.isBindingLive.mockReturnValue(false);
    if (cause === "shutdown") lifetime.abort();
    f.server.checkPending();
    await processing; // Does not wait for an abort-ignoring human promise.
    expect(signal?.aborted).toBe(true);
    const outcome = readDelegatedTerminal(f.path, f.request);
    expect(outcome).toEqual(cancelledPermissionDecision());
    f.human.resolve(servingApproval);
    await vi.advanceTimersByTimeAsync(0);
    expect(readDelegatedTerminal(f.path, f.request)).toEqual(outcome);
    expect(f.recordSessionApproval).not.toHaveBeenCalled();
  });

  it("arbitrates cancellation after the human selection but before commit", async () => {
    const f = fixture();
    f.escalate.mockImplementation(() => {
      publishDelegatedTerminal(
        f.path,
        f.request,
        cancelledPermissionDecision(),
      );
      return Promise.resolve(servingApproval);
    });
    await f.server.processInbox(f.context);
    expect(readDelegatedTerminal(f.path, f.request)).toEqual(
      cancelledPermissionDecision(),
    );
    expect(f.recordSessionApproval).not.toHaveBeenCalled();
  });

  it("rechecks known-dead requester liveness at commit without waiting for a manager tick", async () => {
    const f = fixture();
    f.escalate.mockImplementation(() => {
      f.isBindingLive.mockReturnValue(false);
      return Promise.resolve(servingApproval);
    });
    await f.server.processInbox(f.context);
    expect(readDelegatedTerminal(f.path, f.request)).toEqual(
      cancelledPermissionDecision(),
    );
    expect(f.recordSessionApproval).not.toHaveBeenCalled();
    // Undetected abrupt death remains the documented PID/heartbeat observation window.
  });

  it("does not prompt for an unknown binding", async () => {
    const f = fixture();
    f.isBindingLive.mockReturnValue(false);
    await f.server.processInbox(f.context);
    expect(f.escalate).not.toHaveBeenCalled();
    expect(f.recordSessionApproval).not.toHaveBeenCalled();
    expect(readDelegatedTerminal(f.path, f.request)).toEqual(
      cancelledPermissionDecision(),
    );
  });

  it("preserves exact deadline provenance and observes a late rejection", async () => {
    const f = fixture();
    const processing = f.server.processInbox(f.context);
    await vi.advanceTimersByTimeAsync(1000);
    await processing;
    expect(readDelegatedTerminal(f.path, f.request)).toEqual(
      FORWARDED_PERMISSION_TIMEOUT_DECISION,
    );
    f.human.reject(new Error("late UI failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.recordSessionApproval).not.toHaveBeenCalled();
  });
});

describe("delegation across separate processes", () => {
  it.each([
    "cancel",
    "loss",
  ] as const)("settles %s before competing approval without execution or grants", async (cause) => {
    vi.useRealTimers();
    const f = makeDelegationProcessParent(temp);
    const { identity, context, control, human, grants } = f;
    const processFixture = startDelegationProcess(f.config);
    const { child, receive, closed } = processFixture;
    let processing: Promise<void> | undefined;
    try {
      const started = await f.beginRequest(processFixture);
      processing = started.processing;
      const { ready, published, requestPath, request, terminal } = started;
      const delegationId = String(ready.delegationId);
      expect(ready).toMatchObject({
        capability: "interactive-delegation-v1",
        parentSessionId: identity.parentSessionId,
        childSessionId: identity.childSessionId,
        pid: child.pid,
      });
      expect(child.pid).not.toBe(process.pid);
      expect(control.isBindingLive(delegationId, identity)).toBe(true);
      expect(published.waits).toBe(1);
      expect(request.delegation.identity).toEqual(identity);
      const prompt = await started.prompt;
      expect(prompt.requestSignal?.aborted).toBe(false);
      if (cause === "loss") f.stopServing();
      child.send(cause === "cancel" ? "cancel" : "observe-loss");
      const settled = await receive("settled");
      expect(settled).toEqual({
        kind: "settled",
        outcome: { action: "block", reason: "Permission request cancelled" },
        childGrants: [],
        waits: 0,
        bindingLive: cause === "cancel",
        bindingAvailable: cause === "cancel",
        bindingAborted: cause === "loss",
      });
      expect(existsSync(requestPath)).toBe(false);
      expect(existsSync(join(temp.forwardingDir, "executed"))).toBe(false);
      expect(readDelegatedTerminal(terminal, request)).toEqual(
        cancelledPermissionDecision(),
      );
      const heartbeat = join(
        temp.forwardingDir,
        "delegations",
        identity.parentSessionId,
        "children",
        `${delegationId}.json`,
      );
      expect(existsSync(heartbeat)).toBe(cause === "cancel");
      control.process(context); // Still serviced while the human promise is pending.
      expect(control.isBindingLive(delegationId, identity)).toBe(
        cause === "cancel",
      );
      human.resolve(servingApproval); // Release the competing candidate only after cancellation's commit.
      await processing;
      expect(prompt.requestSignal?.aborted).toBe(true);
      expect(grants.getRuleset()).toEqual([]);
      expect(publishDelegatedTerminal(terminal, request, childApproval)).toBe(
        false,
      );
      expect(readDelegatedTerminal(terminal, request)).toEqual(
        cancelledPermissionDecision(),
      );
      expect(readdirSync(dirname(terminal))).toEqual([`${request.id}.json`]);
      child.send("finish");
      expect(await closed, processFixture.stderr).toBe(0);
    } finally {
      f.stopServing();
      human.resolve(cancelledPermissionDecision());
      await processFixture.dispose();
      await processing;
    }
  }, 25000);
});

describe("strict negotiated envelopes", () => {
  it.each([
    "requestId",
    "delegationId",
    "expiresAt",
  ] as const)("rejects a terminal with a mismatched %s", (field) => {
    const request = requestFixture();
    const path = delegatedTerminalPath(temp.forwardingDir, request);
    publishDelegatedTerminal(path, request, childApproval);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.transaction[field] = field === "expiresAt" ? 2001 : "other";
    writeFileSync(path, JSON.stringify(raw));
    expect(() => readDelegatedTerminal(path, request)).toThrow(
      "Mismatched delegated terminal",
    );
  });

  it.each([
    { approved: false, state: "approved" },
    { approved: true, state: "denied" },
    { approved: true, state: "approved_for_serving_session" },
    { approved: true, state: "approved", confirmationUnavailable: true },
    { approved: false, state: "denied", forwardingTimedOut: true },
  ])("rejects contradictory wire decision %j", (decision) => {
    expect(
      validateDelegatedDecision({ ...decision, decidedBy: DECIDED_BY_HUMAN }),
    ).toBeUndefined();
  });

  it("rejects malformed delegated markers without legacy downgrade", () => {
    const request = requestFixture();
    const path = join(temp.location.requestsDir, `${request.id}.json`);
    for (const delegation of [
      null,
      {},
      { ...request.delegation, requestId: "other" },
      { ...request.delegation, capability: "old" },
    ]) {
      writeFileSync(path, JSON.stringify({ ...request, delegation }));
      expect(readForwardedPermissionRequest(null, path)).toBeNull();
    }
  });
});
