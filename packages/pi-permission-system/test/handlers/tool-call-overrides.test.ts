import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import {
  ToolCallOverrides,
  type ToolOverrideSession,
} from "#src/handlers/tool-call-overrides";
import { normalizeHooksConfig } from "#src/hook-normalize";
import { posixPathFlavor } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path-normalizer";
import {
  resolveToolPreviewLimits,
  ToolPreviewFormatter,
} from "#src/tool-preview-formatter";
import type { PermissionCheckResult } from "#src/types";
import { makeCheckResult, makeCtx } from "#test/helpers/handler-fixtures";

function makeSession(
  configOverrides: Partial<typeof DEFAULT_EXTENSION_CONFIG> = {},
  hooks?: ToolOverrideSession["getHooks"] extends () => infer T ? T : never,
) {
  const allowedDomains = new Set<string>();
  const config = { ...DEFAULT_EXTENSION_CONFIG, ...configOverrides };
  return {
    config,
    getPathNormalizer: () =>
      new PathNormalizer(posixPathFlavor, "/test/project"),
    getHooks: () => hooks,
    getAllowedFetchDomains: () => allowedDomains,
    addAllowedFetchDomain: vi.fn((domain: string) => {
      allowedDomains.add(domain);
    }),
    persistAllowedFetchDomain: vi.fn(() => true),
  } satisfies ToolOverrideSession;
}

function makeHarness(
  session: ToolOverrideSession,
  webDecision: {
    approved: boolean;
    state: "approved" | "denied" | "denied_with_reason";
    domain: string;
    domainAction?: "allow_persist" | "allow_session";
    denialReason?: string;
  } = { approved: true, state: "approved", domain: "example.com" },
) {
  const webPrompter = { prompt: vi.fn().mockResolvedValue(webDecision) };
  const reporter = {
    writeReviewLog: vi.fn(),
    emitDecision: vi.fn(),
  };
  const logger = { debug: vi.fn(), review: vi.fn() };
  const overrides = new ToolCallOverrides(
    session,
    webPrompter,
    reporter,
    logger,
  );
  const formatter = new ToolPreviewFormatter(
    resolveToolPreviewLimits(DEFAULT_EXTENSION_CONFIG),
  );
  const ctx = makeCtx();
  Object.assign(ctx.sessionManager, {
    getSessionId: vi.fn().mockReturnValue("session-1"),
    getSessionDir: vi.fn().mockReturnValue("/sessions/session-1"),
  });
  return { overrides, formatter, ctx, webPrompter, reporter, logger };
}

function tcc(
  toolName: string,
  input: unknown,
): {
  toolName: string;
  agentName: string | null;
  input: unknown;
  toolCallId: string;
  cwd: string;
} {
  return {
    toolName,
    agentName: null,
    input,
    toolCallId: "tc-1",
    cwd: "/test/project",
  };
}

const denyCheck = (): PermissionCheckResult =>
  makeCheckResult({ state: "deny", toolName: "edit", origin: "global" });

describe("ToolCallOverrides local edit behavior", () => {
  it("allows a denied edit inside cwd when allowLocalEdits is enabled", async () => {
    const session = makeSession({ allowLocalEdits: true });
    const harness = makeHarness(session);
    const result = await harness.overrides.apply(
      tcc("edit", { path: "src/a.ts" }),
      harness.ctx,
      denyCheck(),
      harness.formatter,
    );

    expect(result).toEqual({
      action: "continue",
      check: { ...denyCheck(), state: "allow" },
    });
    expect(harness.reporter.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.local_edit_allowed",
      expect.objectContaining({ resolution: "allow_local_edits" }),
    );
  });

  it("lets a deny hook veto the local-edit override", async () => {
    const hooks = normalizeHooksConfig({
      PreToolUse: [
        {
          matcher: "Edit",
          hooks: [{ type: "command", command: "echo blocked >&2; exit 2" }],
        },
      ],
    });
    const harness = makeHarness(makeSession({ allowLocalEdits: true }, hooks));
    const result = await harness.overrides.apply(
      tcc("edit", { path: "src/a.ts" }),
      harness.ctx,
      denyCheck(),
      harness.formatter,
    );

    expect(result).toEqual({ action: "block", reason: "blocked" });
  });

  it("does not let an ask hook undo the local-edit override", async () => {
    const hooks = normalizeHooksConfig({
      PreToolUse: [
        {
          matcher: "Edit",
          hooks: [
            {
              type: "command",
              command:
                'printf \'{"hookSpecificOutput":{"permissionDecision":"ask"}}\'',
            },
          ],
        },
      ],
    });
    const harness = makeHarness(makeSession({ allowLocalEdits: true }, hooks));
    const result = await harness.overrides.apply(
      tcc("edit", { path: "src/a.ts" }),
      harness.ctx,
      denyCheck(),
      harness.formatter,
    );

    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.check.state).toBe("allow");
    }
  });
});

describe("ToolCallOverrides web access behavior", () => {
  it("allows web search tools when allowWebAccess is enabled", async () => {
    const harness = makeHarness(makeSession({ allowWebAccess: true }));
    const result = await harness.overrides.apply(
      tcc("web_search", { query: "hooks" }),
      harness.ctx,
      makeCheckResult({ state: "deny", toolName: "web_search" }),
      harness.formatter,
    );

    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.check.state).toBe("allow");
    }
  });

  it("prompts for an unapproved fetch_content domain and remembers a session grant", async () => {
    const session = makeSession({ allowWebAccess: true });
    const harness = makeHarness(session, {
      approved: true,
      state: "approved",
      domain: "example.com",
      domainAction: "allow_session",
    });
    const result = await harness.overrides.apply(
      tcc("fetch_content", { url: "https://example.com/docs" }),
      harness.ctx,
      makeCheckResult({ state: "ask", toolName: "fetch_content" }),
      harness.formatter,
    );

    expect(result).toEqual({ action: "allow" });
    expect(session.addAllowedFetchDomain).toHaveBeenCalledWith("example.com");
    expect(harness.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "fetch_content",
        value: "example.com",
        result: "allow",
      }),
    );
  });

  it("falls back to a session grant when persistent storage fails", async () => {
    const session = makeSession({ allowWebAccess: true });
    session.persistAllowedFetchDomain.mockReturnValue(false);
    const harness = makeHarness(session, {
      approved: true,
      state: "approved",
      domain: "example.com",
      domainAction: "allow_persist",
    });
    const result = await harness.overrides.apply(
      tcc("fetch_content", { url: "https://example.com/docs" }),
      harness.ctx,
      makeCheckResult({ state: "ask", toolName: "fetch_content" }),
      harness.formatter,
    );

    expect(result).toEqual({ action: "allow" });
    expect(session.addAllowedFetchDomain).toHaveBeenCalledWith("example.com");
    expect(harness.reporter.writeReviewLog).toHaveBeenCalledWith(
      "web_access.domain_persist_failed",
      expect.objectContaining({ domain: "example.com" }),
    );
  });

  it("blocks a denied fetch_content domain prompt with the supplied reason", async () => {
    const harness = makeHarness(makeSession({ allowWebAccess: true }), {
      approved: false,
      state: "denied_with_reason",
      domain: "example.com",
      denialReason: "not trusted",
    });
    const result = await harness.overrides.apply(
      tcc("fetch_content", { url: "https://example.com/docs" }),
      harness.ctx,
      makeCheckResult({ state: "ask", toolName: "fetch_content" }),
      harness.formatter,
    );

    expect(result).toEqual({
      action: "block",
      reason: "User denied fetch_content for example.com: not trusted",
    });
  });
});
