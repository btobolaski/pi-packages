/**
 * Tests for PermissionGateHandler's PreToolUse hook wiring.
 *
 * The hook *executor* (which spawns a process and parses output) is tested
 * separately in tests/hook-runner.test.ts. These tests focus on how the
 * gate handler folds a hook decision into the final allow/deny result,
 * interacts with the config-override layer, and emits debug/review logs.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { PermissionGateHandler } from "#src/handlers/permission-gate-handler";
import { normalizeHookMatcher } from "#src/hook-normalize";
import type { HooksConfig, PreToolUseHookMatcher } from "#src/hook-types";
import type { PermissionSession } from "#src/permission-session";
import type { ToolRegistry } from "#src/tool-registry";
import type { PermissionCheckResult } from "#src/types";

// Mock the hook runner so we control the merged decision without spawning
// subprocesses. `vi.hoisted` lets the factory close over the mock fn even
// though `vi.mock` itself is hoisted above import statements.
const { runPreToolUseHooksMock } = vi.hoisted(() => ({
  runPreToolUseHooksMock: vi.fn(),
}));
vi.mock("../../src/hook-runner", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/hook-runner")>();
  return { ...original, runPreToolUseHooks: runPreToolUseHooksMock };
});

function buildMatcher(): PreToolUseHookMatcher {
  const matcher = normalizeHookMatcher({
    matcher: "Read",
    hooks: [{ type: "command", command: "exit 0" }],
  });
  if (!matcher) throw new Error("matcher normalization failed");
  return matcher;
}

function makeHooks(): HooksConfig {
  return { PreToolUse: [buildMatcher()] };
}

function makeCtx(): ExtensionContext {
  return {
    cwd: "/test/project",
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
    },
    sessionManager: {
      getEntries: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn().mockReturnValue("session-test"),
      getSessionDir: vi.fn().mockReturnValue("/sessions/test"),
      addEntry: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

function makeSession(
  initialState: PermissionCheckResult["state"],
  overrides: Partial<Record<keyof PermissionSession, unknown>> = {},
): PermissionSession {
  const check: PermissionCheckResult = {
    state: initialState,
    toolName: "read",
    source: "tool",
    origin: "builtin",
  };
  return {
    logger: { debug: vi.fn(), review: vi.fn(), warn: vi.fn() },
    activate: vi.fn(),
    resolveAgentName: vi.fn().mockReturnValue(null),
    checkPermission: vi.fn().mockReturnValue(check),
    getToolPermission: vi.fn().mockReturnValue("allow"),
    getSessionRuleset: vi.fn().mockReturnValue([]),
    approveSessionRule: vi.fn(),
    getActiveSkillEntries: vi.fn().mockReturnValue([]),
    getInfrastructureDirs: vi.fn().mockReturnValue([]),
    getInfrastructureReadPaths: vi.fn().mockReturnValue([]),
    canPrompt: vi.fn().mockReturnValue(true),
    prompt: vi.fn().mockResolvedValue({ approved: true, state: "approved" }),
    config: { ...DEFAULT_EXTENSION_CONFIG },
    getAllowedFetchDomains: vi.fn().mockReturnValue(new Set<string>()),
    addAllowedFetchDomain: vi.fn(),
    persistAllowedFetchDomain: vi
      .fn()
      .mockReturnValue({ persisted: true, domains: [] }),
    promptWebAccess: vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" }),
    createPermissionRequestId: vi.fn().mockReturnValue("req-test"),
    getHooks: vi.fn().mockReturnValue(makeHooks()),
    ...overrides,
  } as unknown as PermissionSession;
}

function makeHandler(session: PermissionSession): PermissionGateHandler {
  const events = {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
  const toolRegistry = {
    getAll: vi
      .fn()
      .mockReturnValue([
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "fetch_content" },
      ]),
    setActive: vi.fn(),
  } as unknown as ToolRegistry;
  return new PermissionGateHandler(session, events, toolRegistry);
}

const toolCallEvent = {
  type: "tool_call",
  toolCallId: "tc-1",
  name: "read",
  input: { path: "/test/project/x.ts" },
};

describe("PermissionGateHandler PreToolUse hooks", () => {
  beforeEach(() => {
    runPreToolUseHooksMock.mockReset();
  });

  it("blocks the call when a hook returns deny", async () => {
    runPreToolUseHooksMock.mockResolvedValueOnce({
      decision: "deny",
      reasons: ["no reading allowed"],
    });
    const session = makeSession("allow");
    const handler = makeHandler(session);

    const result = await handler.handleToolCall(toolCallEvent, makeCtx());

    expect(result).toEqual({
      block: true,
      reason: "no reading allowed",
    });
    expect(session.logger.review).toHaveBeenCalledWith(
      "permission_request.blocked",
      expect.objectContaining({
        source: "pretooluse_hook",
        resolution: "hook_denied",
        hookReasons: ["no reading allowed"],
      }),
    );
  });

  it("uses a fallback reason when the hook gives no reasons", async () => {
    runPreToolUseHooksMock.mockResolvedValueOnce({
      decision: "deny",
      reasons: [],
    });
    const session = makeSession("allow");
    const handler = makeHandler(session);

    const result = await handler.handleToolCall(toolCallEvent, makeCtx());

    expect(result).toEqual({
      block: true,
      reason: "Blocked by PreToolUse hook",
    });
  });

  it("forces allow when a hook returns allow on an ask policy", async () => {
    runPreToolUseHooksMock.mockResolvedValueOnce({
      decision: "allow",
      reasons: [],
    });
    const session = makeSession("ask", {
      canPrompt: vi.fn().mockReturnValue(false),
    });
    const handler = makeHandler(session);

    // With ask + no UI, the standard gate would block; allow-from-hook
    // should let it through.
    const result = await handler.handleToolCall(toolCallEvent, makeCtx());

    expect(result).toEqual({});
  });

  it("logs updatedInput and additionalContext as unsupported", async () => {
    runPreToolUseHooksMock.mockResolvedValueOnce({
      decision: "allow",
      reasons: [],
      updatedInput: { new: 1 },
      additionalContext: "more ctx",
    });
    const session = makeSession("allow");
    const handler = makeHandler(session);

    await handler.handleToolCall(toolCallEvent, makeCtx());

    expect(session.logger.debug).toHaveBeenCalledWith(
      "hook.updated_input_not_supported",
      expect.objectContaining({ updatedInput: { new: 1 } }),
    );
    expect(session.logger.debug).toHaveBeenCalledWith(
      "hook.additional_context_not_supported",
      expect.objectContaining({ additionalContext: "more ctx" }),
    );
  });

  it("does not re-introduce a prompt when a config override already forced allow", async () => {
    runPreToolUseHooksMock.mockResolvedValueOnce({
      decision: "ask",
      reasons: [],
    });
    const session = makeSession("ask", {
      config: { ...DEFAULT_EXTENSION_CONFIG, allowLocalEdits: true },
      canPrompt: vi.fn().mockReturnValue(false),
    });
    const handler = makeHandler(session);

    const editEvent = {
      type: "tool_call",
      toolCallId: "tc-2",
      name: "edit",
      input: { file_path: "/test/project/x.ts" },
    };

    // allowLocalEdits forced allow; hook "ask" must not turn it back to ask.
    const result = await handler.handleToolCall(editEvent, makeCtx());

    expect(result).toEqual({});
  });

  it("leaves the effective state unchanged when the decision is defer", async () => {
    runPreToolUseHooksMock.mockResolvedValueOnce({
      decision: "defer",
      reasons: [],
    });
    const session = makeSession("allow");
    const handler = makeHandler(session);

    const result = await handler.handleToolCall(toolCallEvent, makeCtx());

    expect(result).toEqual({});
    expect(session.logger.debug).not.toHaveBeenCalledWith(
      "hook.pretooluse_result",
      expect.anything(),
    );
  });

  it("runs PreToolUse hooks BEFORE the fetch_content per-domain dialog", async () => {
    // Regression test for the gate-ordering fix: configured PreToolUse hooks
    // must get a chance to deny/ask a `fetch_content` call before the
    // per-domain web-access dialog is opened. Otherwise a user could be
    // prompted to allow a domain that policy hooks would have rejected.
    runPreToolUseHooksMock.mockResolvedValueOnce({
      decision: "deny",
      reasons: ["hooks veto fetch"],
    });
    const fetchCheck: PermissionCheckResult = {
      state: "ask",
      toolName: "fetch_content",
      source: "tool",
      origin: "builtin",
    };
    const promptWebAccess = vi.fn();
    const session = makeSession("ask", {
      checkPermission: vi.fn().mockReturnValue(fetchCheck),
      config: { ...DEFAULT_EXTENSION_CONFIG, allowWebAccess: true },
      promptWebAccess,
    });
    const handler = makeHandler(session);

    const fetchEvent = {
      type: "tool_call",
      toolCallId: "tc-fetch",
      name: "fetch_content",
      input: { url: "https://example.com/doc" },
    };

    const result = await handler.handleToolCall(fetchEvent, makeCtx());

    expect(result).toEqual({
      block: true,
      reason: "hooks veto fetch",
    });
    expect(promptWebAccess).not.toHaveBeenCalled();
  });

  it("skips hook execution entirely when no hooks are configured", async () => {
    const session = makeSession("allow", {
      getHooks: vi.fn().mockReturnValue(undefined),
    });
    const handler = makeHandler(session);

    runPreToolUseHooksMock.mockClear();
    const result = await handler.handleToolCall(toolCallEvent, makeCtx());

    expect(result).toEqual({});
    expect(runPreToolUseHooksMock).not.toHaveBeenCalled();
  });
});
