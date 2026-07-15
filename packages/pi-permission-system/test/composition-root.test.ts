/**
 * Composition-root tests for `piPermissionSystemExtension(pi)`.
 *
 * These run the real factory via the `makeFakePi()` harness and assert the
 * wiring contracts that unit tests cannot see: handler-registration
 * completeness, shared-instance contracts across factory invocations, teardown,
 * service↔gate registry sharing, and `ready`-after-publish ordering.
 *
 * Every test runs the factory, which mutates two process-global `Symbol.for()`
 * slots and reads `PI_CODING_AGENT_DIR`. The shared `beforeEach`/`afterEach`
 * isolate the agent dir to a tmpdir and clear both global slots so factory runs
 * do not leak across tests.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPermissionForwardingLocation,
  type ForwardedPermissionRequest,
} from "#src/authority/permission-forwarding";
import { SUBAGENT_CHILD_SESSION_CREATED } from "#src/authority/subagent-lifecycle-events";
import { getSubagentSessionRegistry } from "#src/authority/subagent-registry";
import {
  getGlobalConfigPath,
  getGlobalLogsDir,
  REVIEW_LOG_FILENAME,
} from "#src/config-paths";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import piPermissionSystemExtension from "#src/index";
import {
  PERMISSIONS_READY_CHANNEL,
  PERMISSIONS_UI_PROMPT_CHANNEL,
} from "#src/permission-events";
import { getPermissionsService } from "#src/service";
import { makeFakePi } from "#test/helpers/make-fake-pi";

const SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");
const SUBAGENT_REGISTRY_KEY = Symbol.for(
  "@gotgenes/pi-permission-system:subagent-registry",
);

/** The six events the factory must register a handler for. */
const EXPECTED_HANDLERS = [
  "before_agent_start",
  "input",
  "resources_discover",
  "session_shutdown",
  "session_start",
  "tool_call",
];

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-perm-comp-root-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  // Drop both process-global slots so factory runs do not leak across tests.
  const store = globalThis as Record<symbol, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property
  delete store[SERVICE_KEY];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property
  delete store[SUBAGENT_REGISTRY_KEY];
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Write the global config file under the stubbed agent dir. */
function writeGlobalConfig(config: Record<string, unknown>): void {
  const globalConfigPath = getGlobalConfigPath(agentDir);
  mkdirSync(dirname(globalConfigPath), { recursive: true });
  writeFileSync(
    globalConfigPath,
    `${JSON.stringify({ ...DEFAULT_EXTENSION_CONFIG, ...config }, null, 2)}\n`,
    "utf8",
  );
}

/** Build a minimal subagent `ctx` (no UI) for driving tool-call gates. */
function makeChildCtx(cwd: string, sessionId: string): unknown {
  return {
    cwd,
    hasUI: false,
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionId: (): string => sessionId,
      getSessionDir: (): string => cwd,
    },
    ui: {
      notify: (): void => {},
      setStatus: (): void => {},
      select: async (): Promise<string | undefined> => undefined,
      input: async (): Promise<string | undefined> => undefined,
    },
  };
}

/**
 * Build a UI-present `ctx` that records the titles passed to `ui.select`, and
 * approves every prompt. The ask-prompt message (which embeds the tool-input
 * preview) is the first line of the select title.
 */
function makeUiCtx(cwd: string, capturedTitles: string[]): { ctx: unknown } {
  const ctx = {
    cwd,
    hasUI: true,
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionId: (): string => "ui-session",
      getSessionDir: (): string => cwd,
    },
    ui: {
      notify: (): void => {},
      setStatus: (): void => {},
      select: async (title: string): Promise<string | undefined> => {
        capturedTitles.push(title);
        return "Yes";
      },
      input: async (): Promise<string | undefined> => undefined,
    },
  };
  return { ctx };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Drive the registered `session_start` handler with a ctx. */
function fireSessionStart(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
): Promise<unknown> {
  return pi.fire("session_start", { reason: "start" }, ctx);
}

/**
 * Simulate the parent UI session responding to a forwarded permission request.
 *
 * Polls the parent's requests directory for the child's request file, then
 * writes an approval response so the child's forwarding poll resolves quickly
 * instead of waiting out the 10-minute timeout.
 */
async function approveForwardedRequest(
  forwardingDir: string,
  parentSessionId: string,
): Promise<ForwardedPermissionRequest> {
  const location = createPermissionForwardingLocation(
    forwardingDir,
    parentSessionId,
  );
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    let files: string[] = [];
    try {
      files = readdirSync(location.requestsDir).filter((f) =>
        f.endsWith(".json"),
      );
    } catch {
      files = [];
    }
    const requestFile = files[0];
    if (requestFile) {
      const request = JSON.parse(
        readFileSync(join(location.requestsDir, requestFile), "utf8"),
      ) as ForwardedPermissionRequest;
      mkdirSync(location.responsesDir, { recursive: true });
      writeFileSync(
        join(location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: parentSessionId,
          respondedAt: Date.now(),
        }),
        "utf8",
      );
      return request;
    }
    await sleep(5);
  }
  throw new Error("Timed out waiting for the forwarded permission request");
}

describe("event-handler registration completeness", () => {
  it("registers a handler for every required event exactly once", () => {
    const pi = makeFakePi();
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);

    expect([...pi.handlers.keys()].sort()).toEqual(EXPECTED_HANDLERS);
  });
});

describe("subagent registry sharing across factory instances", () => {
  // The #296 regression class: two factory invocations on *different* event
  // buses must still resolve the same process-global SubagentSessionRegistry,
  // so a child registered via the parent's bus detects itself as a subagent and
  // forwards (rather than blocking) an external-directory `ask`.
  it("lets a child instance forward an ask it received via the parent's bus", async () => {
    writeGlobalConfig({
      permission: { "*": "allow", external_directory: "ask" },
    });

    const childCwd = mkdtempSync(join(tmpdir(), "pi-perm-child-cwd-"));
    const externalDir = mkdtempSync(join(tmpdir(), "pi-perm-external-"));
    const forwardingDir = join(agentDir, "sessions", "permission-forwarding");
    const parentSessionId = "parent-session-1";
    const childSessionId = "child-session-1";

    // Two factory instances, each wired to its own event bus (as in production:
    // every session's ResourceLoader creates a separate bus).
    const parentBus = createEventBus();
    const childBus = createEventBus();
    piPermissionSystemExtension(
      makeFakePi({ events: parentBus }) as unknown as ExtensionAPI,
    );
    const childPi = makeFakePi({
      events: childBus,
      toolNames: ["read"],
    });
    piPermissionSystemExtension(childPi as unknown as ExtensionAPI);

    // The child session is announced on the *parent's* bus only; the parent's
    // lifecycle subscription writes it into the shared global registry.
    parentBus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: childSessionId,
      parentSessionId,
    });

    // The child fires an external-directory read with no UI. With the shared
    // registry it detects itself as a subagent and forwards; the simulated
    // parent approves.
    const firePromise = childPi.fire(
      "tool_call",
      {
        toolName: "read",
        toolCallId: "child-external-read",
        input: { path: join(externalDir, "secret.txt") },
      },
      makeChildCtx(childCwd, childSessionId),
    );

    const request = await approveForwardedRequest(
      forwardingDir,
      parentSessionId,
    );
    expect(request.targetSessionId).toBe(parentSessionId);
    expect(request.requesterSessionId).toBe(childSessionId);
    // The child persists the original display fields so the parent emits a
    // non-degraded `permissions:ui_prompt` event (forwarded non-degradation).
    expect(request.source).toBe("tool_call");
    expect(request.surface).toBe("read");
    expect(request.value).toBe(join(externalDir, "secret.txt"));

    const result = (await firePromise) as { block?: true };
    expect(result.block).toBeUndefined();

    rmSync(childCwd, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  });
});

describe("shutdown teardown chain", () => {
  it("unpublishes the service and unsubscribes the lifecycle on shutdown", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-teardown-cwd-"));
    const pi = makeFakePi();
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);

    // The service is published at session_start, not at factory init.
    await fireSessionStart(pi, makeChildCtx(cwd, "top-session"));
    expect(getPermissionsService()).toBeDefined();

    await pi.fire("session_shutdown");

    // Service slot cleared.
    expect(getPermissionsService()).toBeUndefined();

    // Lifecycle unsubscribed: a post-shutdown session-created must not register.
    pi.events.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: "late-child",
      parentSessionId: "p-late",
    });
    expect(getSubagentSessionRegistry().has("late-child")).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("service and gate share one formatter registry", () => {
  // A formatter registered through the published service must be consulted by
  // the live gate handler — proving both reference the same
  // ToolInputFormatterRegistry instance the factory created once.
  it("surfaces a service-registered formatter in the gate's ask prompt", async () => {
    writeGlobalConfig({
      permission: { "*": "allow", demo: "ask" },
    });

    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-ui-cwd-"));
    const pi = makeFakePi({ toolNames: ["demo"] });
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);

    const capturedTitles: string[] = [];
    const { ctx } = makeUiCtx(cwd, capturedTitles);
    // The service is published at session_start; publish before resolving it.
    await fireSessionStart(pi, ctx);

    const previewMarker = "PREVIEW::shared-registry-proof";
    getPermissionsService()!.registerToolInputFormatter(
      "demo",
      () => previewMarker,
    );
    const result = (await pi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "demo-ask", input: { foo: "bar" } },
      ctx,
    )) as { block?: true };

    // The gate prompted (not blocked) and the prompt embedded the formatter's
    // preview — so the gate consulted the same registry the service wrote to.
    expect(result.block).toBeUndefined();
    expect(capturedTitles.some((t) => t.includes(previewMarker))).toBe(true);

    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("interactive prompt queue wiring", () => {
  it("serializes concurrent standard and web-domain prompts", async () => {
    writeGlobalConfig({
      allowWebAccess: true,
      permission: { "*": "allow", demo: "ask", fetch_content: "ask" },
    });

    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-queue-cwd-"));
    const pi = makeFakePi({ toolNames: ["demo", "fetch_content"] });
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);
    const uiPrompts: unknown[] = [];
    pi.events.on(PERMISSIONS_UI_PROMPT_CHANNEL, (event) => {
      uiPrompts.push(event);
    });

    const firstDecision = Promise.withResolvers<string | undefined>();
    const secondDecision = Promise.withResolvers<string | undefined>();
    const pendingDecisions = [firstDecision, secondDecision];
    const select = vi.fn((title: string): Promise<string | undefined> => {
      const decision = pendingDecisions.shift();
      if (!decision) {
        return Promise.reject(new Error(`Unexpected selector: ${title}`));
      }
      return decision.promise;
    });
    const ctx = {
      cwd,
      hasUI: true,
      sessionManager: {
        getEntries: (): unknown[] => [],
        getSessionId: (): string => "queue-session",
        getSessionDir: (): string => cwd,
      },
      ui: {
        notify: (): void => {},
        setStatus: (): void => {},
        select,
        input: async (): Promise<string | undefined> => undefined,
      },
    };
    await fireSessionStart(pi, ctx);

    const standardResult = pi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "standard-ask", input: {} },
      ctx,
    );
    await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());

    const webResult = pi.fire(
      "tool_call",
      {
        toolName: "fetch_content",
        toolCallId: "web-ask",
        input: { url: "https://example.com" },
      },
      ctx,
    );
    const reviewLogPath = join(getGlobalLogsDir(agentDir), REVIEW_LOG_FILENAME);
    await vi.waitFor(() => {
      const entries = readFileSync(reviewLogPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { event?: string; requestId?: string },
        );
      expect(entries).toContainEqual(
        expect.objectContaining({
          event: "permission_request.waiting",
          requestId: "web-ask",
        }),
      );
    });

    expect(select).toHaveBeenCalledOnce();
    expect(uiPrompts).toHaveLength(1);

    firstDecision.resolve("Yes");
    await expect(standardResult).resolves.toEqual({});
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    expect(uiPrompts).toHaveLength(2);
    expect(uiPrompts[1]).toEqual(
      expect.objectContaining({ requestId: "web-ask" }),
    );
    expect(select.mock.calls[1]?.[0]).toContain(
      "Allow fetch_content to access example.com?",
    );

    secondDecision.resolve("Yes");
    await expect(webResult).resolves.toEqual({});
    expect(select).toHaveBeenCalledTimes(2);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("fails an old interaction closed and admits the next session", async () => {
    writeGlobalConfig({
      permission: { "*": "allow", demo: "ask" },
    });

    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-queue-lifecycle-cwd-"));
    const pi = makeFakePi({ toolNames: ["demo"] });
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);

    const oldDecision = Promise.withResolvers<string | undefined>();
    const newDecision = Promise.withResolvers<string | undefined>();
    const oldSelect = vi.fn(() => oldDecision.promise);
    const newSelect = vi.fn(() => newDecision.promise);
    const makeCtxWithSelect = (
      sessionId: string,
      select: (title: string) => Promise<string | undefined>,
    ) => ({
      cwd,
      hasUI: true,
      sessionManager: {
        getEntries: (): unknown[] => [],
        getSessionId: (): string => sessionId,
        getSessionDir: (): string => cwd,
      },
      ui: {
        notify: (): void => {},
        setStatus: (): void => {},
        select,
        input: async (): Promise<string | undefined> => undefined,
      },
    });
    const oldCtx = makeCtxWithSelect("old-session", oldSelect);
    const newCtx = makeCtxWithSelect("new-session", newSelect);
    await fireSessionStart(pi, oldCtx);

    const oldResult = pi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "old-ask", input: {} },
      oldCtx,
    );
    await vi.waitFor(() => expect(oldSelect).toHaveBeenCalledOnce());

    await fireSessionStart(pi, newCtx);
    await expect(oldResult).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("session changed"),
    });

    const newResult = pi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "new-ask", input: {} },
      newCtx,
    );
    await vi.waitFor(() => expect(newSelect).toHaveBeenCalledOnce());
    expect(oldSelect).toHaveBeenCalledOnce();

    newDecision.resolve("Yes");
    await expect(newResult).resolves.toEqual({});

    oldDecision.resolve("Yes");
    await Promise.resolve();
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("service and gate share one access extractor registry", () => {
  // An extractor registered through the published service must be consulted by
  // the live gate handler — proving both reference the same
  // ToolAccessExtractorRegistry instance the factory created once (#352).
  it("path-gates a custom-shaped tool via a service-registered extractor", async () => {
    writeGlobalConfig({
      permission: { "*": "allow", path: { "*.env": "deny" } },
    });

    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-ext-cwd-"));
    const pi = makeFakePi({ toolNames: ["ffgrep"] });
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);

    const { ctx } = makeUiCtx(cwd, []);
    await fireSessionStart(pi, ctx);

    // ffgrep carries its path under a non-standard key; without the extractor
    // the default input.path convention would miss it.
    getPermissionsService()!.registerToolAccessExtractor("ffgrep", (input) =>
      typeof input.target === "string" ? input.target : undefined,
    );

    const result = (await pi.fire(
      "tool_call",
      { toolName: "ffgrep", toolCallId: "ff-1", input: { target: ".env" } },
      ctx,
    )) as { block?: true };

    // The path deny fired — so the gate extracted ffgrep's path through the
    // same registry the service wrote to.
    expect(result.block).toBe(true);

    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("ready emitted after service publication", () => {
  // Ordering contracts exist only at the composition root: a consumer reacting
  // to permissions:ready must be able to resolve the service immediately. The
  // service is published and ready fires at session_start (not factory init).
  it("publishes the service before emitting permissions:ready", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-ready-cwd-"));
    const seen: string[] = [];
    const pi = makeFakePi();
    pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
      seen.push(getPermissionsService() ? "present" : "missing");
    });

    piPermissionSystemExtension(pi as unknown as ExtensionAPI);

    // ready is not emitted at load; only after session_start publishes.
    expect(seen).toEqual([]);

    await fireSessionStart(pi, makeChildCtx(cwd, "top-session"));

    expect(seen).toEqual(["present"]);

    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("single source of truth for session state", () => {
  // Regression guard for the split-brain bug: before the fix, the gate path
  // recorded session approvals into a private SessionRules instance that the
  // service never saw. After the fix, both readers use the same SessionRules
  // the gate writes into.
  it("gate session-approval is visible to the service", async () => {
    writeGlobalConfig({
      permission: { "*": "allow", demo: "ask" },
    });

    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-sot-cwd-"));
    const pi = makeFakePi({ toolNames: ["demo"] });
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);

    // UI ctx that approves the gate prompt for this session (options[1]).
    const ctx = {
      cwd,
      hasUI: true,
      sessionManager: {
        getEntries: (): unknown[] => [],
        getSessionId: (): string => "sot-session",
        getSessionDir: (): string => cwd,
      },
      ui: {
        notify: (): void => {},
        setStatus: (): void => {},
        // Return the second option label-agnostically — always the
        // "for this session" choice regardless of the exact label text.
        select: async (
          _title: string,
          options: string[],
        ): Promise<string | undefined> => options[1],
        input: async (): Promise<string | undefined> => undefined,
      },
    };

    await fireSessionStart(pi, ctx);

    // Drive a tool_call on "demo"; the gate prompts and the mock selects
    // options[1], recording a session-scoped approval.
    await pi.fire(
      "tool_call",
      {
        toolName: "demo",
        toolCallId: "demo-for-session",
        input: { foo: "bar" },
      },
      ctx,
    );

    // Service accessor must see the session approval.
    // Before the fix this was "ask" — the service read an empty SessionRules.
    const serviceResult = getPermissionsService()!.checkPermission("demo");
    expect(serviceResult.state).toBe("allow");

    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("service path queries evaluate the supplied path (#503)", () => {
  // Before #503 the service path query dropped the value (buildInputForSurface
  // returned {} for the `path` surface), so the query collapsed to ["*"] and a
  // path-specific rule never fired. The query now builds an AccessPath, so the
  // supplied path flows through the resolver → manager and matches `path` rules
  // end-to-end.
  it("resolves a path-surface query against a deny rule on the supplied path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-svc-path-cwd-"));
    const target = join(cwd, "secrets.env");
    writeGlobalConfig({ permission: { path: { [target]: "deny" } } });

    const pi = makeFakePi({ events: createEventBus() });
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);
    await fireSessionStart(pi, makeChildCtx(cwd, "svc-path-session"));

    const result = getPermissionsService()!.checkPermission("path", target);
    expect(result.state).toBe("deny");

    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("bash bare-filename path gating (#509)", () => {
  // Before #509 a bash bare-filename argument (`cat id_rsa`) bypassed the
  // `path` surface entirely: the broad classifier only accepted tokens
  // starting with `.`, containing `/`, containing `..`, or a Windows
  // drive-letter absolute path. The same file accessed via a prefixed path
  // (`cat ./id_rsa`) or the `read` tool was already gated. Rule-driven
  // promotion closes the gap for a bare token matching a specific, non-`*`
  // `path` deny/ask rule — the literal repro from the issue.

  async function fireBashToolCall(
    pi: ReturnType<typeof makeFakePi>,
    ctx: unknown,
    command: string,
  ): Promise<{ block?: true; reason?: string }> {
    return (await pi.fire(
      "tool_call",
      { name: "bash", input: { command }, toolCallId: "tc-1" },
      ctx,
    )) as { block?: true; reason?: string };
  }

  it("denies a bare filename matching a specific path deny rule", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-bare-token-cwd-"));
    writeGlobalConfig({
      permission: { "*": "allow", path: { id_rsa: "deny" } },
    });

    const pi = makeFakePi({ events: createEventBus() });
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);
    const ctx = makeChildCtx(cwd, "bare-token-session-deny");
    await fireSessionStart(pi, ctx);

    const result = await fireBashToolCall(pi, ctx, "cat id_rsa");
    expect(result.block).toBe(true);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("denies a bare filename matching a wildcard path deny rule", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-bare-token-cwd-"));
    writeGlobalConfig({
      permission: { "*": "allow", path: { "*.pem": "deny" } },
    });

    const pi = makeFakePi({ events: createEventBus() });
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);
    const ctx = makeChildCtx(cwd, "bare-token-session-wildcard");
    await fireSessionStart(pi, ctx);

    const result = await fireBashToolCall(pi, ctx, "cat key.pem");
    expect(result.block).toBe(true);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("leaves a bare token that does not match any path rule unaffected", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-bare-token-cwd-"));
    writeGlobalConfig({
      permission: { "*": "allow", path: { id_rsa: "deny" } },
    });

    const pi = makeFakePi({ events: createEventBus() });
    piPermissionSystemExtension(pi as unknown as ExtensionAPI);
    const ctx = makeChildCtx(cwd, "bare-token-session-unaffected");
    await fireSessionStart(pi, ctx);

    const result = await fireBashToolCall(pi, ctx, "git status");
    expect(result.block).toBeUndefined();

    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("multi-instance global service interplay", () => {
  // The fix (#302) scopes the process-global service slot to the publishing
  // instance. The parent publishes at its session_start; an in-process child
  // (registered by session id) skips publishing, and its identity-scoped
  // teardown is a no-op — so the parent's service is the one that resolves
  // throughout the child's lifecycle and survives the child's shutdown.
  it("keeps the parent's service published across the child's lifecycle", async () => {
    const parentCwd = mkdtempSync(join(tmpdir(), "pi-perm-parent-cwd-"));
    const childCwd = mkdtempSync(join(tmpdir(), "pi-perm-child-cwd-"));
    const childSessionId = "child-session-mi";

    const parentPi = makeFakePi({ events: createEventBus() });
    piPermissionSystemExtension(parentPi as unknown as ExtensionAPI);
    const childPi = makeFakePi({ events: createEventBus() });
    piPermissionSystemExtension(childPi as unknown as ExtensionAPI);

    // The parent is not a registered child, so it publishes its service.
    await fireSessionStart(
      parentPi,
      makeChildCtx(parentCwd, "parent-session-mi"),
    );
    const parentService = getPermissionsService();
    expect(parentService).toBeDefined();

    // The child is registered in the shared global registry before its own
    // session_start, so it detects itself and skips publishing.
    getSubagentSessionRegistry().register(childSessionId, {
      parentSessionId: "parent-session-mi",
    });
    await fireSessionStart(childPi, makeChildCtx(childCwd, childSessionId));

    // Mid-run: the slot resolves the parent's service, never the child's.
    expect(getPermissionsService()).toBe(parentService);

    // The child's shutdown is a no-op for the slot it never owned.
    await childPi.fire("session_shutdown");
    expect(getPermissionsService()).toBe(parentService);

    rmSync(parentCwd, { recursive: true, force: true });
    rmSync(childCwd, { recursive: true, force: true });
  });
});

describe("session approvals do not leak across same-cwd session switches", () => {
  // Pi caches the extension *import* (the jiti module, factory function) for
  // same-cwd `/new` / `/resume` / `/fork` / `/import` switches
  // (earendil-works/pi#5905). The factory is still re-invoked per switch, and
  // `session_shutdown` still fires — so a session-scoped "allow for this
  // session" grant must not survive into the next session.
  //
  // Two factory invocations against the same cwd model the cached-import
  // switch: invocation #1 records an approval and shuts down; invocation #2 is
  // the re-invoked cached factory. The new session must start with an empty
  // SessionRules. Two independent mechanisms keep it empty, and the grant only
  // leaks if *both* break together: `session_shutdown` clears the first
  // instance's rules, and the re-invoked factory builds a fresh SessionRules
  // (no module-scoped state bridges the switch — the per-session reset the
  // fresh-jiti load used to provide is gone once the import is cached).

  /** A UI ctx that approves the gate's "for this session" option (options[1]). */
  function makeSessionApprovingCtx(cwd: string, sessionId: string): unknown {
    return {
      cwd,
      hasUI: true,
      sessionManager: {
        getEntries: (): unknown[] => [],
        getSessionId: (): string => sessionId,
        getSessionDir: (): string => cwd,
      },
      ui: {
        notify: (): void => {},
        setStatus: (): void => {},
        select: async (
          _title: string,
          options: string[],
        ): Promise<string | undefined> => options[1],
        input: async (): Promise<string | undefined> => undefined,
      },
    };
  }

  it("starts the next same-cwd session with an empty session ruleset", async () => {
    writeGlobalConfig({
      permission: { "*": "allow", demo: "ask" },
    });

    const cwd = mkdtempSync(join(tmpdir(), "pi-perm-switch-cwd-"));

    // ── Session #1: approve `demo` for the session, then shut down ──────────
    const firstPi = makeFakePi({ toolNames: ["demo"] });
    piPermissionSystemExtension(firstPi as unknown as ExtensionAPI);

    const firstCtx = makeSessionApprovingCtx(cwd, "switch-session-1");
    await fireSessionStart(firstPi, firstCtx);

    // The gate prompts and the mock selects options[1], recording a
    // session-scoped approval the service can read back.
    await firstPi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "demo-approve", input: { foo: "bar" } },
      firstCtx,
    );
    expect(getPermissionsService()!.checkPermission("demo").state).toBe(
      "allow",
    );

    // The switch tears down the old session before the new one starts.
    await firstPi.fire("session_shutdown");

    // ── Session #2: the re-invoked cached factory, same cwd ────────────────
    const secondPi = makeFakePi({ toolNames: ["demo"] });
    piPermissionSystemExtension(secondPi as unknown as ExtensionAPI);

    await fireSessionStart(secondPi, makeChildCtx(cwd, "switch-session-2"));

    // The previous session's approval must not be visible: `demo` is back to
    // its configured `ask`, not the carried-over `allow`.
    expect(getPermissionsService()!.checkPermission("demo").state).toBe("ask");

    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("forwarded grant-scope selection round-trip", () => {
  // A UI-present serving ctx whose `select` drives the two-step forwarded
  // dialog: the main prompt picks "for this session" (options[1]); the scope
  // prompt (options include a "The whole session …" label) returns the chosen
  // scope. Every `select` options array is recorded so a test can prove the
  // human was (or was not) re-prompted.
  function makeServingCtx(
    cwd: string,
    sessionId: string,
    selectLog: string[][],
    scope: "whole" | "subagent",
  ): unknown {
    return {
      cwd,
      hasUI: true,
      sessionManager: {
        getEntries: (): unknown[] => [],
        getSessionId: (): string => sessionId,
        getSessionDir: (): string => cwd,
      },
      ui: {
        notify: (): void => {},
        setStatus: (): void => {},
        select: async (
          _title: string,
          options: string[],
        ): Promise<string | undefined> => {
          selectLog.push(options);
          const wholeOption = options.find((o) =>
            o.startsWith("The whole session"),
          );
          if (wholeOption) {
            return scope === "whole" ? wholeOption : options[0];
          }
          return options[1];
        },
        input: async (): Promise<string | undefined> => undefined,
      },
    };
  }

  it("records a whole-session grant on the serving node so later forwards and the parent's own action resolve without a second prompt", async () => {
    writeGlobalConfig({ permission: { "*": "allow", demo: "ask" } });

    const parentCwd = mkdtempSync(join(tmpdir(), "pi-perm-parent-"));
    const childCwd = mkdtempSync(join(tmpdir(), "pi-perm-child-"));
    const parentSessionId = "parent-whole-1";
    const childSessionId = "child-whole-1";
    const selectLog: string[][] = [];

    const parentBus = createEventBus();
    const parentPi = makeFakePi({ events: parentBus, toolNames: ["demo"] });
    piPermissionSystemExtension(parentPi as unknown as ExtensionAPI);
    const childPi = makeFakePi({
      events: createEventBus(),
      toolNames: ["demo"],
    });
    piPermissionSystemExtension(childPi as unknown as ExtensionAPI);

    // The parent starts serving (its poll drains the inbox using the UI ctx).
    const parentCtx = makeServingCtx(
      parentCwd,
      parentSessionId,
      selectLog,
      "whole",
    );
    await fireSessionStart(parentPi, parentCtx);
    parentBus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: childSessionId,
      parentSessionId,
    });

    // 1. First child `demo` forwards; the human grants the whole session.
    const firstResult = (await childPi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "demo-1", input: {} },
      makeChildCtx(childCwd, childSessionId),
    )) as { block?: true };
    expect(firstResult.block).toBeUndefined();
    // One serve = main dialog + scope dialog.
    expect(selectLog).toHaveLength(2);

    // 2. A second child `demo` re-forwards and the serving node auto-approves
    // from its recorded whole-session grant — no new human prompt.
    const secondResult = (await childPi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "demo-2", input: {} },
      makeChildCtx(childCwd, childSessionId),
    )) as { block?: true };
    expect(secondResult.block).toBeUndefined();
    expect(selectLog).toHaveLength(2);

    // 3. The parent's own `demo` is session-approved by the same grant.
    const parentResult = (await parentPi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "demo-parent", input: {} },
      parentCtx,
    )) as { block?: true };
    expect(parentResult.block).toBeUndefined();
    expect(selectLog).toHaveLength(2);

    await parentPi.fire("session_shutdown");
    rmSync(parentCwd, { recursive: true, force: true });
    rmSync(childCwd, { recursive: true, force: true });
  });

  it("contains a subagent-only grant to the requesting child so the parent's own action still prompts", async () => {
    writeGlobalConfig({ permission: { "*": "allow", demo: "ask" } });

    const parentCwd = mkdtempSync(join(tmpdir(), "pi-perm-parent-"));
    const childCwd = mkdtempSync(join(tmpdir(), "pi-perm-child-"));
    const parentSessionId = "parent-sub-1";
    const childSessionId = "child-sub-1";
    const selectLog: string[][] = [];

    const parentBus = createEventBus();
    const parentPi = makeFakePi({ events: parentBus, toolNames: ["demo"] });
    piPermissionSystemExtension(parentPi as unknown as ExtensionAPI);
    const childPi = makeFakePi({
      events: createEventBus(),
      toolNames: ["demo"],
    });
    piPermissionSystemExtension(childPi as unknown as ExtensionAPI);

    const parentCtx = makeServingCtx(
      parentCwd,
      parentSessionId,
      selectLog,
      "subagent",
    );
    await fireSessionStart(parentPi, parentCtx);
    parentBus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: childSessionId,
      parentSessionId,
    });

    // 1. First child `demo` forwards; the human grants this subagent only.
    const firstResult = (await childPi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "demo-1", input: {} },
      makeChildCtx(childCwd, childSessionId),
    )) as { block?: true };
    expect(firstResult.block).toBeUndefined();
    expect(selectLog).toHaveLength(2);

    // 2. The child recorded the grant locally: its next `demo` resolves as a
    // session approval with no forward, so the serving node is not consulted.
    const secondResult = (await childPi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "demo-2", input: {} },
      makeChildCtx(childCwd, childSessionId),
    )) as { block?: true };
    expect(secondResult.block).toBeUndefined();
    expect(selectLog).toHaveLength(2);

    // 3. The parent holds no grant, so its own `demo` prompts again.
    const parentResult = (await parentPi.fire(
      "tool_call",
      { toolName: "demo", toolCallId: "demo-parent", input: {} },
      parentCtx,
    )) as { block?: true };
    expect(parentResult.block).toBeUndefined();
    expect(selectLog.length).toBeGreaterThan(2);

    await parentPi.fire("session_shutdown");
    rmSync(parentCwd, { recursive: true, force: true });
    rmSync(childCwd, { recursive: true, force: true });
  });
});
