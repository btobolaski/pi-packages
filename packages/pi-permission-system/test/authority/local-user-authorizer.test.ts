import { describe, expect, it, vi } from "vitest";
import { SerialInteractivePromptQueue } from "#src/authority/interactive-prompt-queue";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import type { requestPermissionDecision } from "#src/authority/permission-prompt-component";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import { DECIDED_BY_HUMAN } from "#test/helpers/decision-fixtures";
import {
  makePromptDetails,
  makePromptPayload,
} from "#test/helpers/prompt-details-fixtures";
import { makePromptPreferences } from "#test/helpers/prompt-view-fixtures";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * This file's semantic defaults over the shared structural fixture: several
 * cases assert `agentName` and `toolName` on a no-override call.
 */
function makeDetails(
  overrides?: Partial<PromptPermissionDetails>,
): PromptPermissionDetails {
  return makePromptDetails({
    requestId: "req-123",
    agentName: "test-agent",
    toolName: "read",
    ...overrides,
  });
}

/** A `PermissionPromptUi` double; the tool-expansion accessors go unused here. */
function makePromptUi() {
  return {
    select: vi.fn(),
    input: vi.fn(),
    custom: vi.fn(),
    getToolsExpanded: vi.fn(() => false),
    setToolsExpanded: vi.fn(),
  };
}

function makeDeps(
  overrides: {
    requestPermissionDecision?: typeof requestPermissionDecision;
    setPromptIndicator?: (active: boolean) => Promise<void>;
  } = {},
) {
  const events = {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
  const ui = makePromptUi();
  const decisionFn =
    overrides.requestPermissionDecision ??
    vi.fn<typeof requestPermissionDecision>().mockResolvedValue({
      approved: true,
      state: "approved",
      decidedBy: DECIDED_BY_HUMAN,
    });
  const setPromptIndicator =
    overrides.setPromptIndicator ?? vi.fn().mockResolvedValue(undefined);
  return {
    deps: {
      ui,
      mode: "tui" as const,
      events,
      getPromptPreferences: () => makePromptPreferences(),
      promptQueue: new SerialInteractivePromptQueue(),
      requestPermissionDecision: decisionFn,
      setPromptIndicator,
    },
    events,
    ui,
    decisionFn,
    setPromptIndicator,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("LocalUserAuthorizer", () => {
  it("emits a UI prompt event with normalized surface and value", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        toolName: "bash",
        command: "git push",
        toolInputPreview: "git push",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      agentName: "test-agent",
      request: makePromptPayload().request,
      forwarding: null,
    });
  });

  it("normalizes skill prompt events to the skill surface", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        source: "skill_input",
        toolName: undefined,
        skillName: "deploy-helper",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "skill_input",
      surface: "skill",
      value: "deploy-helper",
      agentName: "test-agent",
      request: makePromptPayload().request,
      forwarding: null,
    });
  });

  it("calls requestPermissionDecision with the threaded view, title, and payload", async () => {
    const { deps, ui, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);
    const details = makeDetails();

    await authorizer.authorize(details);

    expect(decisionFn).toHaveBeenCalledWith(
      {
        mode: "tui",
        ui,
        ...makePromptPreferences(),
        signal: expect.any(AbortSignal),
      },
      "Permission Required",
      details.payload,
      undefined,
    );
  });

  it("passes the sessionLabel option when present", async () => {
    const { deps, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({ sessionLabel: "Yes, for 'read' tool" }),
    );

    expect(decisionFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      { sessionLabel: "Yes, for 'read' tool" },
    );
  });

  it("propagates indicator activation failure before opening the dialog", async () => {
    const failure = new Error("indicator failed");
    const setPromptIndicator = vi.fn().mockRejectedValue(failure);
    const { deps, decisionFn } = makeDeps({ setPromptIndicator });
    const authorizer = new LocalUserAuthorizer(deps);

    await expect(authorizer.authorize(makeDetails())).rejects.toBe(failure);
    expect(setPromptIndicator).toHaveBeenCalledOnce();
    expect(setPromptIndicator).toHaveBeenCalledWith(true);
    expect(decisionFn).not.toHaveBeenCalled();
  });

  it("marks the prompt immediately around the existing event and dialog sequence", async () => {
    const calls: string[] = [];
    const events = {
      emit: vi.fn(() => {
        calls.push("emit");
      }),
      on: vi.fn().mockReturnValue(() => undefined),
    };
    const ui = makePromptUi();
    const decisionFn = vi.fn<typeof requestPermissionDecision>(() => {
      calls.push("dialog");
      return Promise.resolve({
        approved: true,
        state: "approved",
        decidedBy: DECIDED_BY_HUMAN,
      });
    });
    const authorizer = new LocalUserAuthorizer({
      ui,
      mode: "tui",
      events,
      getPromptPreferences: () => makePromptPreferences(),
      promptQueue: new SerialInteractivePromptQueue(),
      requestPermissionDecision: decisionFn,
      setPromptIndicator: async (active) => {
        calls.push(active ? "activate" : "clear");
      },
    });

    await authorizer.authorize(makeDetails());

    expect(calls).toEqual(["activate", "emit", "dialog", "clear"]);
  });

  describe("forwarded provenance", () => {
    it("emits a non-degraded forwarded event with populated forwarding and the child's display projection", async () => {
      const { deps, events, setPromptIndicator } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          source: "tool_call",
          agentName: "Explore",
          surface: "bash",
          value: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
        requestId: "req-123",
        source: "tool_call",
        surface: "bash",
        value: "git push",
        agentName: "Explore",
        request: makePromptPayload().request,
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      });
      expect(setPromptIndicator).toHaveBeenNthCalledWith(1, true);
      expect(setPromptIndicator).toHaveBeenNthCalledWith(2, false);
    });

    it("uses the '(Subagent)' dialog title when the ask is forwarded", async () => {
      const { deps, ui, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);
      const details = makeDetails({
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      });

      await authorizer.authorize(details);

      expect(decisionFn).toHaveBeenCalledWith(
        {
          mode: "tui",
          ui,
          ...makePromptPreferences(),
          signal: expect.any(AbortSignal),
        },
        "Permission Required (Subagent)",
        details.payload,
        undefined,
      );
    });

    it("offers a sessionScope when the forwarded ask carries a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          toolName: "bash",
          command: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
          sessionApproval: { surface: "bash", patterns: ["git *"] },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        "Permission Required (Subagent)",
        expect.anything(),
        {
          sessionScope: {
            subagentLabel: "This subagent ('Explore') only",
            servingSessionLabel:
              'The whole session — allow bash "git *" for parent and all subagents',
          },
        },
      );
    });

    it("offers no sessionScope for a forwarded ask without a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        undefined,
      );
    });
  });

  it.each([
    [
      "approval",
      {
        approved: true,
        state: "approved",
        decidedBy: DECIDED_BY_HUMAN,
      } satisfies PermissionPromptDecision,
    ],
    [
      "denial",
      {
        approved: false,
        state: "denied",
        decidedBy: DECIDED_BY_HUMAN,
      } satisfies PermissionPromptDecision,
    ],
  ])("returns a %s unchanged and clears the indicator", async (_name, decision) => {
    const { deps, setPromptIndicator } = makeDeps({
      requestPermissionDecision: vi
        .fn<typeof requestPermissionDecision>()
        .mockResolvedValue(decision),
    });
    const authorizer = new LocalUserAuthorizer(deps);

    await expect(authorizer.authorize(makeDetails())).resolves.toEqual(
      decision,
    );
    expect(setPromptIndicator).toHaveBeenNthCalledWith(1, true);
    expect(setPromptIndicator).toHaveBeenNthCalledWith(2, false);
  });

  it("preserves a dialog rejection and clears the indicator", async () => {
    const failure = new Error("dialog failed");
    const { deps, setPromptIndicator } = makeDeps({
      requestPermissionDecision: vi
        .fn<typeof requestPermissionDecision>()
        .mockRejectedValue(failure),
    });
    const authorizer = new LocalUserAuthorizer(deps);

    await expect(authorizer.authorize(makeDetails())).rejects.toBe(failure);
    expect(setPromptIndicator).toHaveBeenNthCalledWith(1, true);
    expect(setPromptIndicator).toHaveBeenNthCalledWith(2, false);
  });

  it("preserves queue cancellation and clears the indicator", async () => {
    const queue = new SerialInteractivePromptQueue();
    const decisionFn = vi.fn<typeof requestPermissionDecision>(({ signal }) => {
      if (!signal) throw new Error("expected prompt queue signal");
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("dialog aborted")),
          { once: true },
        );
      });
    });
    const { deps, setPromptIndicator } = makeDeps({
      requestPermissionDecision: decisionFn,
    });
    deps.promptQueue = queue;
    const authorizer = new LocalUserAuthorizer(deps);

    const pending = authorizer.authorize(makeDetails());
    await vi.waitFor(() => expect(decisionFn).toHaveBeenCalledOnce());
    queue.invalidate("The permission session changed.");

    await expect(pending).rejects.toMatchObject({
      name: "InteractivePromptCancelledError",
      message: "The permission session changed.",
    });
    await vi.waitFor(() =>
      expect(setPromptIndicator).toHaveBeenNthCalledWith(2, false),
    );
  });
});
