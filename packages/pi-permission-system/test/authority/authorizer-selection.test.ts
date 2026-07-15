/**
 * Unit tests for AuthorizerSelection.
 *
 * AuthorizerSelection owns the stored ExtensionContext and is the sole
 * implementation of the AskEscalator role. These tests verify the
 * escalate/reject contract across activation state.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { AuthorizerSelectionDeps as SelectionCtorDeps } from "#src/authority/authorizer";
import { AuthorizerSelection } from "#src/authority/authorizer-selection";
import { SerialInteractivePromptQueue } from "#src/authority/interactive-prompt-queue";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import type {
  PermissionPrompterApi,
  PromptPermissionDetails,
} from "#src/authority/permission-prompter";
import type { SubagentDetector } from "#src/authority/subagent-detection";

// ── Test helpers ──────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
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
      getSessionId: vi.fn().mockReturnValue(null),
      addEntry: vi.fn(),
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

function makePrompterApi(): PermissionPrompterApi & {
  prompt: ReturnType<typeof vi.fn>;
} {
  return {
    prompt: vi
      .fn<PermissionPrompterApi["prompt"]>()
      .mockResolvedValue({ approved: true, state: "approved" }),
  };
}

function makeDetails(): PromptPermissionDetails {
  return {
    requestId: "req-1",
    source: "tool_call",
    agentName: null,
    message: "Allow this?",
  };
}

function makeDetection(isSubagent = false): SubagentDetector {
  return { isSubagent: vi.fn(() => isSubagent) };
}

type SelectionDeps = SelectionCtorDeps & { prompter: PermissionPrompterApi };

function makeDeps(overrides: Partial<SelectionDeps> = {}): SelectionDeps {
  return {
    detection: overrides.detection ?? makeDetection(),
    events: overrides.events ?? {
      emit: vi.fn(),
      on: vi.fn().mockReturnValue(() => undefined),
    },
    queue: overrides.queue ?? new SerialInteractivePromptQueue(),
    requestPermissionDecisionFromUi:
      overrides.requestPermissionDecisionFromUi ??
      vi.fn().mockResolvedValue({ approved: true, state: "approved" }),
    forwardingDir: overrides.forwardingDir ?? "/tmp/forwarding",
    registry: overrides.registry,
    logger: overrides.logger ?? { review: vi.fn(), debug: vi.fn() },
    prompter: overrides.prompter ?? makePrompterApi(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("AuthorizerSelection", () => {
  describe("escalate", () => {
    it("rejects before activate", async () => {
      const selection = new AuthorizerSelection(makeDeps());
      await expect(selection.escalate(makeDetails())).rejects.toThrow(
        "escalate called before the session was activated",
      );
    });

    it("delegates to deps.prompter.prompt with the selected authorizer", async () => {
      const prompter = makePrompterApi();
      const selection = new AuthorizerSelection(makeDeps({ prompter }));
      const ctx = makeCtx({ hasUI: true });
      selection.activate(ctx);
      const details = makeDetails();

      const result = await selection.escalate(details);

      expect(prompter.prompt).toHaveBeenCalledWith(
        expect.any(LocalUserAuthorizer),
        details,
      );
      expect(result).toEqual({ approved: true, state: "approved" });
    });

    it("uses the most recently selected authorizer", async () => {
      const prompter = makePrompterApi();
      const selection = new AuthorizerSelection(makeDeps({ prompter }));
      selection.activate(makeCtx({ hasUI: false }));
      selection.activate(makeCtx({ hasUI: true }));

      await selection.escalate(makeDetails());

      expect(prompter.prompt).toHaveBeenCalledWith(
        expect.any(LocalUserAuthorizer),
        expect.anything(),
      );
    });

    it("rejects after deactivate", async () => {
      const selection = new AuthorizerSelection(makeDeps());
      selection.activate(makeCtx());
      selection.deactivate();
      await expect(selection.escalate(makeDetails())).rejects.toThrow(
        "escalate called before the session was activated",
      );
    });

    it("returns the prompter decision", async () => {
      const decision: PermissionPromptDecision = {
        approved: false,
        state: "denied",
        denialReason: "user declined",
      };
      const prompter = makePrompterApi();
      prompter.prompt.mockResolvedValue(decision);
      const selection = new AuthorizerSelection(makeDeps({ prompter }));
      selection.activate(makeCtx());

      const result = await selection.escalate(makeDetails());

      expect(result).toEqual(decision);
    });
  });

  describe("lifecycle", () => {
    it("activate then deactivate rejects a subsequent escalate", async () => {
      const selection = new AuthorizerSelection(makeDeps());
      selection.activate(makeCtx());
      selection.deactivate();
      await expect(selection.escalate(makeDetails())).rejects.toThrow(
        "escalate called before the session was activated",
      );
    });

    it("multiple activate calls escalate against the most recent context", async () => {
      const prompter = makePrompterApi();
      const selection = new AuthorizerSelection(makeDeps({ prompter }));
      selection.activate(makeCtx({ cwd: "/old" }));
      selection.activate(makeCtx({ cwd: "/new" }));

      await selection.escalate(makeDetails());

      expect(prompter.prompt).toHaveBeenCalledOnce();
    });
  });
});
