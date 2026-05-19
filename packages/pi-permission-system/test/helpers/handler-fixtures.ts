/**
 * Shared handler-level test fixtures for PermissionGateHandler tests.
 *
 * All factories use override bags so callers can specialize any field
 * without constructing the full object from scratch.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { PermissionGateHandler } from "#src/handlers/permission-gate-handler";
import type { PermissionDecisionEvent } from "#src/permission-events";
import { PERMISSIONS_DECISION_CHANNEL } from "#src/permission-events";
import type { PermissionSession } from "#src/permission-session";
import type { ToolRegistry } from "#src/tool-registry";
import type { PermissionCheckResult } from "#src/types";

export function makeEvents() {
  return {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
}

export function makeCtx(
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
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
      getSessionDir: vi.fn().mockReturnValue("/sessions/test"),
      addEntry: vi.fn(),
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

export function makeToolCallEvent(
  toolName: string,
  extraFields: Record<string, unknown> = {},
) {
  return {
    type: "tool_call",
    toolCallId: "tc-1",
    name: toolName,
    input: {},
    ...extraFields,
  };
}

/**
 * Neutral-default check-result builder.
 *
 * Pass exactly the fields the original fixture hard-coded so divergent
 * defaults across test files are preserved at their call sites.
 */
export function makeCheckResult(
  overrides: Partial<PermissionCheckResult> = {},
): PermissionCheckResult {
  return {
    state: "allow",
    toolName: "read",
    source: "tool",
    origin: "builtin",
    ...overrides,
  };
}

/**
 * Full-union session stub.
 *
 * Includes every method mocked across handler test files so each file
 * only needs to override the fields that differ from the defaults.
 */
export function makeSession(
  overrides: Partial<Record<keyof PermissionSession, unknown>> = {},
): PermissionSession {
  return {
    logger: { debug: vi.fn(), review: vi.fn(), warn: vi.fn() },
    activate: vi.fn(),
    resolveAgentName: vi.fn().mockReturnValue(null),
    checkPermission: vi.fn().mockReturnValue(makeCheckResult()),
    getToolPermission: vi.fn().mockReturnValue("allow"),
    getHooks: vi.fn().mockReturnValue(undefined),
    getSessionRuleset: vi.fn().mockReturnValue([]),
    recordSessionApproval: vi.fn(),
    getActiveSkillEntries: vi.fn().mockReturnValue([]),
    getInfrastructureDirs: vi
      .fn()
      .mockReturnValue(["/test/agent", "/test/agent/git"]),
    getInfrastructureReadPaths: vi.fn().mockReturnValue([]),
    config: DEFAULT_EXTENSION_CONFIG,
    canPrompt: vi.fn().mockReturnValue(true),
    prompt: vi.fn().mockResolvedValue({ approved: true, state: "approved" }),
    promptWebAccess: vi.fn().mockResolvedValue({
      approved: true,
      state: "approved",
      domainAction: "allow_once",
    }),
    getAllowedFetchDomains: vi.fn().mockReturnValue(new Set<string>()),
    addAllowedFetchDomain: vi.fn(),
    persistAllowedFetchDomain: vi
      .fn()
      .mockReturnValue({ persisted: true, domains: [] }),
    createPermissionRequestId: vi.fn().mockReturnValue("req-id"),
    ...overrides,
  } as unknown as PermissionSession;
}

export function makeToolRegistry(
  overrides: Partial<ToolRegistry> = {},
): ToolRegistry {
  return {
    getAll: vi.fn().mockReturnValue([{ name: "read" }, { name: "bash" }]),
    setActive: vi.fn(),
    ...overrides,
  };
}

/**
 * Constructs a PermissionGateHandler with mocked collaborators.
 *
 * Returns all collaborators so each test file can destructure only what
 * it needs — handler, events, session, and toolRegistry are all available.
 */
export function makeHandler(overrides?: {
  session?: Partial<Record<keyof PermissionSession, unknown>>;
  toolRegistry?: Partial<ToolRegistry>;
}) {
  const session = makeSession(overrides?.session);
  const events = makeEvents();
  const toolRegistry = makeToolRegistry(overrides?.toolRegistry);
  const handler = new PermissionGateHandler(session, events, toolRegistry);
  return { handler, events, session, toolRegistry };
}

/** Extract all permissions:decision payloads from the events.emit mock. */
export function getDecisionEvents(
  events: ReturnType<typeof makeEvents>,
): PermissionDecisionEvent[] {
  return events.emit.mock.calls
    .filter(([channel]) => channel === PERMISSIONS_DECISION_CHANNEL)
    .map(([, payload]) => payload as PermissionDecisionEvent);
}
