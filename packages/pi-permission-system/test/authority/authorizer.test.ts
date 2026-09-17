import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ParentAuthorizer } from "#src/authority/approval-escalator";
import { selectAuthorizer } from "#src/authority/authorizer";
import { DenyingAuthorizer } from "#src/authority/denying-authorizer";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type {
  DelegationBinding,
  DelegationState,
} from "#src/authority/permission-delegation";
import {
  makeAuthorizerSelectionDeps as makeDeps,
  makeDetection,
} from "#test/helpers/authorizer-fixtures";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(hasUI: boolean): ExtensionContext {
  return {
    hasUI,
    mode: "tui",
    ui: { select: vi.fn(), input: vi.fn(), custom: vi.fn() },
    sessionManager: {
      getSessionId: vi.fn().mockReturnValue("session-1"),
      getSessionDir: vi.fn().mockReturnValue("/sessions/session-1"),
      getEntries: vi.fn().mockReturnValue([]),
    },
  } as unknown as ExtensionContext;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("selectAuthorizer", () => {
  describe("explicit interactive delegation", () => {
    const identity = {
      parentSessionId: "parent",
      childSessionId: "session-1",
      agentName: "worker",
      childCwd: "/child",
    };
    const ready: DelegationState = {
      status: "ready",
      identity,
      delegationId: "binding",
    };

    it("selects the parent before UI or ambient subagent detection", () => {
      const binding: DelegationBinding = {
        identity,
        delegationId: "binding",
        signal: new AbortController().signal,
        isLive: () => true,
        beginWait: () => vi.fn(),
      };
      const deps = makeDeps({
        detection: makeDetection(false),
        delegation: { getState: () => ready, getBinding: () => binding },
      });
      const authority = selectAuthorizer(makeCtx(true), deps);
      expect(authority.terminal).toBeInstanceOf(ParentAuthorizer);
      expect(authority.adjudicatesLocally).toBe(false);
      expect(deps.detection.isSubagent).not.toHaveBeenCalled();
      expect(deps.requestPermissionDecision).not.toHaveBeenCalled();
    });

    it("denies an unbound required child even with UI", () => {
      const deps = makeDeps({
        delegation: {
          getState: () => ({ status: "unbound" }),
          getBinding: () => undefined,
        },
      });
      const authority = selectAuthorizer(makeCtx(true), deps);
      expect(authority.terminal).toBeInstanceOf(DenyingAuthorizer);
      expect(authority.adjudicatesLocally).toBe(false);
      expect(deps.requestPermissionDecision).not.toHaveBeenCalled();
      expect(deps.detection.isSubagent).not.toHaveBeenCalled();
    });

    it.each([
      true,
      false,
    ])("preserves ordinary subagent dispatch when delegation is not required (UI=%s)", (hasUI) => {
      const getBinding = vi.fn();
      const authority = selectAuthorizer(
        makeCtx(hasUI),
        makeDeps({
          detection: makeDetection(true),
          delegation: {
            getState: () => ({ status: "not-required" }),
            getBinding,
          },
        }),
      );
      expect(authority.terminal).toBeInstanceOf(
        hasUI ? LocalUserAuthorizer : ParentAuthorizer,
      );
      expect(authority.adjudicatesLocally).toBe(hasUI);
      expect(getBinding).not.toHaveBeenCalled();
    });
  });

  describe("terminal dispatch", () => {
    it("selects LocalUserAuthorizer when the context has UI", () => {
      const authority = selectAuthorizer(makeCtx(true), makeDeps());
      expect(authority.terminal).toBeInstanceOf(LocalUserAuthorizer);
    });

    it("selects LocalUserAuthorizer even when the context is also a subagent", () => {
      const authority = selectAuthorizer(
        makeCtx(true),
        makeDeps({ detection: makeDetection(true) }),
      );
      expect(authority.terminal).toBeInstanceOf(LocalUserAuthorizer);
    });

    it("selects ParentAuthorizer without activating the indicator when there is no UI", () => {
      const setPromptIndicator = vi.fn().mockResolvedValue(undefined);
      const authority = selectAuthorizer(
        makeCtx(false),
        makeDeps({
          detection: makeDetection(true),
          setPromptIndicator,
        }),
      );
      expect(authority.terminal).toBeInstanceOf(ParentAuthorizer);
      expect(setPromptIndicator).not.toHaveBeenCalled();
    });

    it("selects DenyingAuthorizer when there is no UI and no subagent", () => {
      const authority = selectAuthorizer(
        makeCtx(false),
        makeDeps({ detection: makeDetection(false) }),
      );
      expect(authority.terminal).toBeInstanceOf(DenyingAuthorizer);
    });
  });

  describe("chain role", () => {
    it("adjudicates locally when the terminal is the human", () => {
      const authority = selectAuthorizer(makeCtx(true), makeDeps());
      expect(authority.adjudicatesLocally).toBe(true);
    });

    it("adjudicates locally when a subagent has its own UI", () => {
      const authority = selectAuthorizer(
        makeCtx(true),
        makeDeps({ detection: makeDetection(true) }),
      );
      expect(authority.adjudicatesLocally).toBe(true);
    });

    it("relays instead of adjudicating when the terminal forwards to a serving node", () => {
      const authority = selectAuthorizer(
        makeCtx(false),
        makeDeps({ detection: makeDetection(true) }),
      );
      expect(authority.adjudicatesLocally).toBe(false);
    });

    it("adjudicates locally when the terminal denies for want of authority", () => {
      const authority = selectAuthorizer(
        makeCtx(false),
        makeDeps({ detection: makeDetection(false) }),
      );
      expect(authority.adjudicatesLocally).toBe(true);
    });
  });
});
