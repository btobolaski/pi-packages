import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ParentAuthorizer } from "#src/authority/approval-escalator";
import {
  cancelledPermissionDecision,
  type DelegatedRequest,
  delegatedTerminalPath,
  publishDelegatedTerminal,
  readDelegatedTerminal,
} from "#src/authority/forwarded-transaction";
import type { DelegationBinding } from "#src/authority/permission-delegation";
import { createUnavailablePermissionDecision } from "#src/authority/permission-dialog";
import {
  FORWARDED_PERMISSION_TIMEOUT_DECISION,
  type ForwardedPermissionRequest,
  PERMISSION_FORWARDING_SERVING_GRACE_MS,
} from "#src/authority/permission-forwarding";
import { ServingSessionRegistry } from "#src/authority/serving-registry";
import {
  createForwardingTempDir,
  makeForwardedAccessIntent,
  makeForwarderContext,
  makeLivenessJudge,
  makeParentAuthorizerDeps,
  makeSubagentRegistry,
  publishServingHeartbeat,
  stubNoSubagentEnvironment,
} from "#test/helpers/forwarding-fixtures";
import {
  makePromptDetails,
  makePromptPayload,
} from "#test/helpers/prompt-details-fixtures";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

beforeEach(stubNoSubagentEnvironment);
afterEach(() => vi.unstubAllEnvs());

// ── Local poll helper ────────────────────────────────────────────────────
//
// The reverse direction of `ForwardingTempDir.writeRequest`: waits for the
// request file ParentAuthorizer.authorize writes, so the test can respond
// as the parent session would. Real timers/filesystem, matching how
// composition-root.test.ts's forwarding round trip already behaves.

async function waitForRequestFile(
  requestsDir: string,
): Promise<ForwardedPermissionRequest> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    let files: string[] = [];
    try {
      files = readdirSync(requestsDir).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    const requestFile = files[0];
    if (requestFile) {
      return JSON.parse(
        readFileSync(join(requestsDir, requestFile), "utf-8"),
      ) as ForwardedPermissionRequest;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a request file in ${requestsDir}`);
}

// ── ParentAuthorizer ──────────────────────────────────────────────────────

/**
 * Drive one forwarded exchange to completion: escalate, wait for the request
 * file, answer it with `response`, and resolve.
 */
async function exchangeWith(
  temp: ReturnType<typeof createForwardingTempDir>,
  response: Record<string, unknown>,
) {
  const authorizer = new ParentAuthorizer(
    makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
    makeParentAuthorizerDeps({
      forwardingDir: temp.forwardingDir,
      registry: makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      }),
    }),
  );
  const decisionPromise = authorizer.authorize(
    makePromptDetails({ requestId: "perm-child-request" }),
  );
  const request = await waitForRequestFile(temp.location.requestsDir);
  writeFileSync(
    join(temp.location.responsesDir, `${request.id}.json`),
    JSON.stringify(response),
    "utf-8",
  );
  return decisionPromise;
}

describe("ParentAuthorizer delegated failure cleanup", () => {
  let temp: ReturnType<typeof createForwardingTempDir>;
  const approval = {
    approved: true,
    state: "approved" as const,
    decidedBy: { kind: "user" as const, via: "dialog" as const },
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    temp = createForwardingTempDir("parent-session");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    temp.cleanup();
  });

  function fixture() {
    const turn = new AbortController();
    const bindingController = new AbortController();
    const endWait = vi.fn();
    const beginWait = vi.fn(() => endWait);
    const isLive = vi.fn(() => true);
    const binding: DelegationBinding = {
      identity: {
        parentSessionId: "parent-session",
        childSessionId: "child-session",
        agentName: "worker",
        childCwd: "/child",
      },
      delegationId: "binding",
      signal: bindingController.signal,
      isLive,
      beginWait,
    };
    const authorizer = new ParentAuthorizer(
      makeForwarderContext({ hasUI: true, sessionId: "child-session" }),
      makeParentAuthorizerDeps({
        forwardingDir: temp.forwardingDir,
        delegation: binding,
        getTimeoutMs: () => 500,
      }),
    );
    const details = makePromptDetails({
      requestId: "perm-delegated",
      accessIntent: makeForwardedAccessIntent(),
      requestSignal: turn.signal,
    });
    const requestPath = join(temp.location.requestsDir, "perm-delegated.json");
    const readRequest = () =>
      JSON.parse(readFileSync(requestPath, "utf8")) as DelegatedRequest;
    return {
      authorizer,
      details,
      turn,
      bindingController,
      isLive,
      beginWait,
      endWait,
      requestPath,
      readRequest,
    };
  }

  test("commits the exact timeout terminal and cannot adopt a late approval", async () => {
    const f = fixture();
    const pending = f.authorizer.authorize(f.details);
    const request = f.readRequest();
    const path = delegatedTerminalPath(temp.forwardingDir, request);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual(FORWARDED_PERMISSION_TIMEOUT_DECISION);
    expect(readDelegatedTerminal(path, request)).toEqual(
      FORWARDED_PERMISSION_TIMEOUT_DECISION,
    );
    expect(publishDelegatedTerminal(path, request, approval)).toBe(false);
    expect(f.beginWait).toHaveBeenCalledExactlyOnceWith("perm-delegated");
    expect(f.endWait).toHaveBeenCalledOnce();
    expect(existsSync(f.requestPath)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("fails closed and ends observation when child-fixed intent is absent", async () => {
    const f = fixture();
    f.details.accessIntent = undefined;
    expect(await f.authorizer.authorize(f.details)).toEqual(
      createUnavailablePermissionDecision(
        "Delegated permission exchange unavailable: Delegated request has no child-fixed access intent",
      ),
    );
    expect(f.beginWait).toHaveBeenCalledExactlyOnceWith("perm-delegated");
    expect(f.endWait).toHaveBeenCalledOnce();
    expect(existsSync(f.requestPath)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("ends observation when the forwarding location cannot be prepared", async () => {
    const f = fixture();
    rmSync(temp.location.requestsDir, { recursive: true });
    writeFileSync(temp.location.requestsDir, "not a directory");
    expect(await f.authorizer.authorize(f.details)).toEqual(
      createUnavailablePermissionDecision(
        "Delegated permission exchange unavailable: Delegated forwarding directory unavailable",
      ),
    );
    expect(f.beginWait).toHaveBeenCalledExactlyOnceWith("perm-delegated");
    expect(f.endWait).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("fails closed on an unreadable terminal without replacing its immutable contents", async () => {
    const f = fixture();
    const pending = f.authorizer.authorize(f.details);
    const request = f.readRequest();
    const path = delegatedTerminalPath(temp.forwardingDir, request);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json");
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual(
      createUnavailablePermissionDecision(
        "Delegated permission exchange unavailable: Unreadable delegated terminal",
      ),
    );
    expect(readFileSync(path, "utf8")).toBe("not json");
    expect(f.endWait).toHaveBeenCalledOnce();
    expect(existsSync(f.requestPath)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("fails closed when the competing terminal disappears after abandonment loses publication", async () => {
    const f = fixture();
    const pending = f.authorizer.authorize(f.details);
    const request = f.readRequest();
    const path = delegatedTerminalPath(temp.forwardingDir, request);
    const fs = await import("node:fs");
    const link = fs.linkSync;
    let contested = false;
    let competitorWon = false;
    const publication = vi
      .spyOn(fs, "linkSync")
      .mockImplementation((source, target) => {
        if (target !== path || contested) {
          link(source, target);
          return;
        }
        contested = true;
        competitorWon = publishDelegatedTerminal(path, request, approval);
        try {
          link(source, target); // Real EEXIST makes abandonment lose.
        } finally {
          rmSync(path); // Lose the winner before the correlated re-read.
        }
      });
    rmSync(f.requestPath);

    await vi.advanceTimersByTimeAsync(250);

    expect(await pending).toEqual(
      createUnavailablePermissionDecision(
        "Delegated permission exchange unavailable: Delegated terminal disappeared during abandonment",
      ),
    );
    expect(competitorWon).toBe(true);
    // The existing error cleanup makes the third publication: cancellation.
    expect(publication).toHaveBeenCalledTimes(3);
    expect(readDelegatedTerminal(path, request)).toEqual(
      cancelledPermissionDecision(),
    );
    expect(f.beginWait).toHaveBeenCalledExactlyOnceWith("perm-delegated");
    expect(f.endWait).toHaveBeenCalledOnce();
    expect(existsSync(f.requestPath)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cleans up a request publication exception without authorizing", async () => {
    const f = fixture();
    mkdirSync(f.requestPath);
    const decision = await f.authorizer.authorize(f.details);
    const reason = expect.stringContaining(
      "Delegated permission exchange unavailable:",
    );
    expect(decision).toEqual({
      approved: false,
      state: "denied",
      confirmationUnavailable: true,
      denialReason: reason,
      decidedBy: { kind: "unavailable", reason },
    });
    expect(f.endWait).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    "turn",
    "binding",
    "not-live",
  ] as const)("ends a wait rejected before publication (%s)", async (source) => {
    const f = fixture();
    if (source === "turn") f.turn.abort();
    else if (source === "binding") f.bindingController.abort();
    else f.isLive.mockReturnValue(false);
    expect(await f.authorizer.authorize(f.details)).toEqual(
      cancelledPermissionDecision(),
    );
    expect(f.beginWait).toHaveBeenCalledExactlyOnceWith("perm-delegated");
    expect(f.endWait).toHaveBeenCalledOnce();
    expect(existsSync(f.requestPath)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("settles cancellation while waiting and ignores a later answer", async () => {
    const f = fixture();
    const pending = f.authorizer.authorize(f.details);
    const request = f.readRequest();
    const path = delegatedTerminalPath(temp.forwardingDir, request);
    f.turn.abort();
    expect(await pending).toEqual(cancelledPermissionDecision());
    expect(readDelegatedTerminal(path, request)).toEqual(
      cancelledPermissionDecision(),
    );
    expect(publishDelegatedTerminal(path, request, approval)).toBe(false);
    expect(f.endWait).toHaveBeenCalledOnce();
    expect(existsSync(f.requestPath)).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("rechecks cancellation after finding an approval without undoing its committed terminal", async () => {
    const f = fixture();
    const pending = f.authorizer.authorize(f.details);
    const request = f.readRequest();
    const path = delegatedTerminalPath(temp.forwardingDir, request);
    publishDelegatedTerminal(path, request, approval);
    let checks = 0;
    f.isLive.mockImplementation(() => {
      checks++;
      if (checks === 2) {
        f.turn.abort();
        return false;
      }
      return true;
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(checks).toBe(2);
    expect(await pending).toEqual(cancelledPermissionDecision());
    expect(readDelegatedTerminal(path, request)).toEqual(approval);
    expect(f.endWait).toHaveBeenCalledOnce();
    expect(existsSync(f.requestPath)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ParentAuthorizer provenance relay", () => {
  test("nests the responder's own decider under the forwarding hop", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      // The reported case: a human at the parent, or the parent's policy?
      // The child's own terminal entry has to answer that.
      await expect(
        exchangeWith(temp, {
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
          decidedBy: { kind: "user", via: "dialog" },
        }),
      ).resolves.toMatchObject({
        decidedBy: {
          kind: "forwarded",
          responderSessionId: "parent-session",
          decision: { kind: "user", via: "dialog" },
        },
      });
    } finally {
      temp.cleanup();
    }
  });

  test("still names the responding session when an older parent sends no decider", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      await expect(
        exchangeWith(temp, {
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
      ).resolves.toMatchObject({
        decidedBy: {
          kind: "forwarded",
          responderSessionId: "parent-session",
          decision: null,
        },
      });
    } finally {
      temp.cleanup();
    }
  });

  test("discards a malformed decider rather than relaying a corrupt one", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      await expect(
        exchangeWith(temp, {
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
          decidedBy: { kind: "user", via: "smoke-signal" },
        }),
      ).resolves.toMatchObject({
        decidedBy: {
          kind: "forwarded",
          responderSessionId: "parent-session",
          decision: null,
        },
      });
    } finally {
      temp.cleanup();
    }
  });
});

describe("ParentAuthorizer", () => {
  test("writes a forwarded request with display fields and a wire-safe snapshotted deadline", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const getTimeoutMs = vi
        .fn()
        .mockReturnValueOnce(Number.MAX_SAFE_INTEGER)
        .mockReturnValue(20_000);
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry,
          getTimeoutMs,
        }),
      );

      const decisionPromise = authorizer.authorize(
        makePromptDetails({
          requestId: "perm-child-request",
          agentName: "Explore",
          toolName: "bash",
          command: "git push",
        }),
      );

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.targetSessionId).toBe("parent-session");
      expect(request.requesterSessionId).toBe("child-session");
      expect(request.source).toBe("tool_call");
      expect(request.surface).toBe("bash");
      expect(request.value).toBe("git push");
      expect(request.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
      expect(getTimeoutMs).toHaveBeenCalledOnce();

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );

      // toMatchObject: the response also carries a live respondedAt timestamp
      // and the responderSessionId/denialReason passthrough fields.
      await expect(decisionPromise).resolves.toMatchObject({
        approved: true,
        state: "approved",
      });
    } finally {
      temp.cleanup();
    }
  });

  test("persists the details' sessionApproval suggestion onto the forwarded request", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry,
        }),
      );

      const decisionPromise = authorizer.authorize(
        makePromptDetails({
          requestId: "perm-child-request",
          agentName: "Explore",
          toolName: "bash",
          command: "git push",
          sessionApproval: { surface: "bash", patterns: ["git *"] },
        }),
      );

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.sessionApproval).toEqual({
        surface: "bash",
        patterns: ["git *"],
      });

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("stamps the child-fixed access intent with requester identity onto the forwarded request", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({
          hasUI: false,
          sessionId: "child-session",
          cwd: "/worktree/issue-42",
        }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry,
        }),
      );

      const decisionPromise = authorizer.authorize(
        makePromptDetails({
          requestId: "perm-child-request",
          agentName: "Explore",
          toolName: "read",
          path: "src/foo.ts",
          accessIntent: {
            surface: "path",
            matchValues: ["/worktree/issue-42/src/foo.ts", "src/foo.ts"],
            boundaryValue: "/worktree/issue-42/src/foo.ts",
          },
        }),
      );

      const request = await waitForRequestFile(temp.location.requestsDir);
      // The display fields still ride the same request alongside the structured
      // intent (the #292/#557 non-degraded-broadcast contract must not regress).
      expect(request.source).toBe("tool_call");
      expect(request.surface).toBe("read");
      expect(request.value).toBe("src/foo.ts");
      // requesterCwd comes from ctx.cwd; principal mirrors the request's own
      // computed identity fields (sessionId, requesterAgentName).
      expect(request.accessIntent).toEqual({
        surface: "path",
        matchValues: ["/worktree/issue-42/src/foo.ts", "src/foo.ts"],
        boundaryValue: "/worktree/issue-42/src/foo.ts",
        requesterCwd: "/worktree/issue-42",
        principal: {
          sessionId: request.requesterSessionId,
          agentName: request.requesterAgentName,
        },
      });

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("relays the details' prompt payload onto the forwarded request", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry,
        }),
      );

      const payload = makePromptPayload({
        kind: "bash",
        request: {
          requester: {
            agentName: "Explore",
            forwarded: false,
            sessionId: null,
          },
          surface: "bash",
          toolName: "bash",
          invokedToolName: null,
          value: "git push",
          matchedPattern: "git *",
          commandContext: null,
          executedUnit: null,
        },
        evidence: [{ label: "command", text: "git push", detail: null }],
      });
      const decisionPromise = authorizer.authorize(
        makePromptDetails({
          requestId: "perm-child-request",
          agentName: "Explore",
          toolName: "bash",
          command: "git push",
          payload,
        }),
      );

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.payload).toEqual(payload);

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("omits accessIntent from the request when the details carry none", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry,
        }),
      );

      const decisionPromise = authorizer.authorize(
        makePromptDetails({
          requestId: "perm-child-request",
          agentName: "Explore",
          toolName: "read",
        }),
      );

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.accessIntent).toBeUndefined();

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("omits sessionApproval from the request when the details carry none", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry,
        }),
      );

      const decisionPromise = authorizer.authorize(
        makePromptDetails({
          requestId: "perm-child-request",
          agentName: "Explore",
          toolName: "read",
        }),
      );

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.sessionApproval).toBeUndefined();

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("returns denied when the response marks the request denied", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry,
        }),
      );

      const decisionPromise = authorizer.authorize(
        makePromptDetails({
          requestId: "perm-child-request",
          agentName: "Explore",
          toolName: "read",
        }),
      );

      const request = await waitForRequestFile(temp.location.requestsDir);
      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: false,
          state: "denied",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );

      // toMatchObject: see the approved-path test for why this isn't toEqual.
      await expect(decisionPromise).resolves.toMatchObject({
        approved: false,
        state: "denied",
      });
    } finally {
      temp.cleanup();
    }
  });

  test("adopts the requester's request id as the forwarded request id", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
        }),
      );

      const decisionPromise = authorizer.authorize(
        makePromptDetails({ requestId: "perm-child-request" }),
      );

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.id).toBe("perm-child-request");

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({ approved: true, state: "approved" }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("mints a fresh id when the requester's is not filename-safe", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
        }),
      );

      const decisionPromise = authorizer.authorize(
        makePromptDetails({ requestId: "../../escape" }),
      );

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.id).toMatch(/^perm-/);

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({ approved: true, state: "approved" }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });
});

// ── Abandonment ─────────────────────────────────────────────────────
//
// Every path where ParentAuthorizer gives up without a human having ruled must
// be distinguishable from a user denial — `confirmationUnavailable` selects the
// "no authority could answer" block message, and `denialReason` says which
// path (#719).

const forwardedAsk = makePromptDetails({
  requestId: "perm-child-request",
  agentName: "Explore",
  toolName: "bash",
});

/**
 * The shape every abandonment resolves to.
 *
 * `denialReason` and the provenance `reason` are the same value by
 * construction: the string that names which path gave up is the string the
 * record attributes it to, so the two cannot drift (#726).
 */
function unavailableDecision(denialReason: unknown) {
  return {
    approved: false,
    state: "denied",
    confirmationUnavailable: true,
    denialReason,
    decidedBy: { kind: "unavailable", reason: denialReason },
  };
}

describe("ParentAuthorizer abandonment", () => {
  test("reports an unresolvable target as unavailable, not user-denied", async () => {
    const authorizer = new ParentAuthorizer(
      makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
      makeParentAuthorizerDeps({
        registry: makeSubagentRegistry("child-session"),
      }),
    );

    await expect(authorizer.authorize({ ...forwardedAsk })).resolves.toEqual(
      unavailableDecision(
        "Could not resolve a parent session to forward this permission request to",
      ),
    );
  });

  test("reports unusable forwarding directories as unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "permission-forwarding-blocked-"));
    try {
      // A file where the forwarding root must be a directory: every mkdir
      // beneath it fails with ENOTDIR.
      const forwardingDir = join(root, "forwarding");
      writeFileSync(forwardingDir, "not a directory", "utf-8");

      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
        }),
      );

      await expect(authorizer.authorize({ ...forwardedAsk })).resolves.toEqual(
        unavailableDecision(
          "Permission forwarding directories could not be prepared for session 'parent-session'",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an unwritable request as unavailable", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      // Deny writes into requests/ so writeJsonFileAtomic's temp write fails.
      chmodSync(temp.location.requestsDir, 0o500);

      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
        }),
      );

      await expect(authorizer.authorize({ ...forwardedAsk })).resolves.toEqual(
        unavailableDecision(
          "The forwarded permission request could not be written",
        ),
      );
      // The directories it created for an exchange that never happened are
      // cleaned up, so the chmod'd directory is already gone.
      expect(existsSync(temp.location.requestsDir)).toBe(false);
    } finally {
      if (existsSync(temp.location.requestsDir)) {
        chmodSync(temp.location.requestsDir, 0o700);
      }
      temp.cleanup();
    }
  });

  test("reports an unreadable response as unavailable, not as the parent's denial", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
        }),
      );

      const decisionPromise = authorizer.authorize({ ...forwardedAsk });
      const request = await waitForRequestFile(temp.location.requestsDir);
      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        "{ not json",
        "utf-8",
      );

      await expect(decisionPromise).resolves.toEqual(
        unavailableDecision(
          "The parent session's permission response could not be read",
        ),
      );
    } finally {
      temp.cleanup();
    }
  });

  test("reports an unanswered request as timed out, not user-denied", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
          getTimeoutMs: () => 400,
        }),
      );

      await expect(authorizer.authorize({ ...forwardedAsk })).resolves.toEqual({
        approved: false,
        state: "denied",
        confirmationUnavailable: true,
        forwardingTimedOut: true,
        denialReason: "Auto-approval could not approve this tool use",
        decidedBy: {
          kind: "unavailable",
          reason: "Auto-approval could not approve this tool use",
        },
      });
    } finally {
      temp.cleanup();
    }
  });

  test("rejects a response observed at the exact deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const temp = createForwardingTempDir("parent-session");
    try {
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
          getTimeoutMs: () => 100,
        }),
      );

      const decision = authorizer.authorize({ ...forwardedAsk });
      const requestFile = readdirSync(temp.location.requestsDir)[0];
      if (!requestFile) throw new Error("expected request file");
      const request = JSON.parse(
        readFileSync(join(temp.location.requestsDir, requestFile), "utf-8"),
      ) as ForwardedPermissionRequest;
      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );

      await vi.advanceTimersByTimeAsync(100);

      await expect(decision).resolves.toMatchObject({
        approved: false,
        forwardingTimedOut: true,
      });
      expect(
        existsSync(join(temp.location.responsesDir, `${request.id}.json`)),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
      temp.cleanup();
    }
  });

  test("honors an explicit timeout longer than the two-minute default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const temp = createForwardingTempDir("parent-session");
    try {
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
          getTimeoutMs: () => 600_000,
        }),
      );

      const decision = authorizer.authorize({ ...forwardedAsk });
      const requestFile = readdirSync(temp.location.requestsDir)[0];
      if (!requestFile) throw new Error("expected request file");
      const requestPath = join(temp.location.requestsDir, requestFile);
      const request = JSON.parse(
        readFileSync(requestPath, "utf-8"),
      ) as ForwardedPermissionRequest;
      expect(request.expiresAt).toBe(request.createdAt + 600_000);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(requestPath)).toBe(true);

      await vi.advanceTimersByTimeAsync(480_000);
      await expect(decision).resolves.toMatchObject({
        approved: false,
        forwardingTimedOut: true,
      });
    } finally {
      vi.useRealTimers();
      temp.cleanup();
    }
  });

  test("abandons quickly when an in-process target is not serving", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
          // Nobody has marked themselves as serving.
          serving: makeLivenessJudge({ forwardingDir: temp.forwardingDir }),
          getTimeoutMs: () => 60_000,
        }),
      );

      const started = Date.now();
      await expect(authorizer.authorize({ ...forwardedAsk })).resolves.toEqual(
        unavailableDecision(
          "Session 'parent-session' is not serving forwarded permission requests",
        ),
      );
      expect(Date.now() - started).toBeLessThan(60_000);
    } finally {
      temp.cleanup();
    }
  });

  test("keeps waiting while the in-process target is serving", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = new ServingSessionRegistry();
      registry.markServing("parent-session");
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
          serving: makeLivenessJudge({
            forwardingDir: temp.forwardingDir,
            registry,
          }),
          getTimeoutMs: () => 60_000,
        }),
      );

      const decisionPromise = authorizer.authorize({ ...forwardedAsk });
      const request = await waitForRequestFile(temp.location.requestsDir);
      // Well past the unserved grace window: a serving target must not be
      // abandoned no matter how long the human deliberates.
      await new Promise((resolve) =>
        setTimeout(resolve, PERMISSION_FORWARDING_SERVING_GRACE_MS + 250),
      );
      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );

      await expect(decisionPromise).resolves.toMatchObject({
        approved: true,
        state: "approved",
      });
    } finally {
      temp.cleanup();
    }
  });

  test("abandons quickly when an out-of-process target published no heartbeat", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      vi.stubEnv("PI_SUBAGENT_PARENT_SESSION", "parent-session");
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          // No registry entry, so the target resolves from the environment: a
          // parent in another process, reachable only through the filesystem.
          registry: makeSubagentRegistry("child-session"),
          serving: makeLivenessJudge({ forwardingDir: temp.forwardingDir }),
          getTimeoutMs: () => 60_000,
        }),
      );

      const started = Date.now();
      await expect(authorizer.authorize({ ...forwardedAsk })).resolves.toEqual(
        unavailableDecision(
          "Session 'parent-session' is not serving forwarded permission requests",
        ),
      );
      expect(Date.now() - started).toBeLessThan(60_000);
    } finally {
      vi.unstubAllEnvs();
      temp.cleanup();
    }
  });

  test("abandons quickly when an out-of-process target's process is gone", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      vi.stubEnv("PI_SUBAGENT_PARENT_SESSION", "parent-session");
      publishServingHeartbeat(temp.forwardingDir, "parent-session", 4242);
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session"),
          serving: makeLivenessJudge({
            forwardingDir: temp.forwardingDir,
            isProcessAlive: () => false,
          }),
          getTimeoutMs: () => 60_000,
        }),
      );

      await expect(authorizer.authorize({ ...forwardedAsk })).resolves.toEqual(
        unavailableDecision(
          "Session 'parent-session' is not serving forwarded permission requests",
        ),
      );
    } finally {
      vi.unstubAllEnvs();
      temp.cleanup();
    }
  });

  test("keeps waiting while an out-of-process target's heartbeat is fresh", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      vi.stubEnv("PI_SUBAGENT_PARENT_SESSION", "parent-session");
      publishServingHeartbeat(temp.forwardingDir, "parent-session");
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session"),
          serving: makeLivenessJudge({ forwardingDir: temp.forwardingDir }),
          getTimeoutMs: () => 60_000,
        }),
      );

      const decisionPromise = authorizer.authorize({ ...forwardedAsk });
      const request = await waitForRequestFile(temp.location.requestsDir);
      // Well past the grace window: a live parent must not be abandoned no
      // matter how long the human deliberates.
      await new Promise((resolve) =>
        setTimeout(resolve, PERMISSION_FORWARDING_SERVING_GRACE_MS + 250),
      );
      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );

      await expect(decisionPromise).resolves.toMatchObject({
        approved: true,
        state: "approved",
      });
    } finally {
      vi.unstubAllEnvs();
      temp.cleanup();
    }
  });

  test("records which channel answered and what it saw when it gives up", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      vi.stubEnv("PI_SUBAGENT_PARENT_SESSION", "parent-session");
      publishServingHeartbeat(temp.forwardingDir, "other-parent");
      const logger = { review: vi.fn(), debug: vi.fn() };
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session"),
          serving: makeLivenessJudge({ forwardingDir: temp.forwardingDir }),
          getTimeoutMs: () => 60_000,
          logger,
        }),
      );

      await authorizer.authorize({ ...forwardedAsk });

      expect(logger.review).toHaveBeenCalledWith(
        "forwarded_permission.no_serving_session",
        expect.objectContaining({
          requesterSessionId: "child-session",
          targetSessionId: "parent-session",
          servingChannel: "heartbeat",
          servingState: "absent",
          servingSessionIds: ["other-parent"],
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      temp.cleanup();
    }
  });

  test("deletes the request it abandoned so the parent cannot answer it later", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        makeParentAuthorizerDeps({
          forwardingDir: temp.forwardingDir,
          registry: makeSubagentRegistry("child-session", {
            parentSessionId: "parent-session",
          }),
          getTimeoutMs: () => 400,
        }),
      );

      await authorizer.authorize({ ...forwardedAsk });

      expect(existsSync(temp.location.requestsDir)).toBe(false);
    } finally {
      temp.cleanup();
    }
  });
});
