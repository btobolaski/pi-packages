import { describe, expect, it, vi } from "vitest";
import { SerialInteractivePromptQueue } from "#src/authority/interactive-prompt-queue";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type {
  PermissionPromptDecision,
  requestPermissionDecisionFromUi,
} from "#src/authority/permission-dialog";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDetails(
  overrides?: Partial<PromptPermissionDetails>,
): PromptPermissionDetails {
  return {
    requestId: "req-123",
    source: "tool_call",
    agentName: "test-agent",
    message: "Allow read?",
    toolName: "read",
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    requestPermissionDecisionFromUi?: typeof requestPermissionDecisionFromUi;
  } = {},
) {
  const events = {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
  const ui = { select: vi.fn(), input: vi.fn() };
  const decisionFn =
    overrides.requestPermissionDecisionFromUi ??
    vi
      .fn<typeof requestPermissionDecisionFromUi>()
      .mockResolvedValue({ approved: true, state: "approved" });
  return {
    deps: {
      ui,
      events,
      queue: new SerialInteractivePromptQueue(),
      requestPermissionDecisionFromUi: decisionFn,
    },
    events,
    ui,
    decisionFn,
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
      message: "Allow read?",
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
      message: "Allow read?",
      forwarding: null,
    });
  });

  it("calls requestPermissionDecisionFromUi with the dialog title and message", async () => {
    const { deps, ui, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(makeDetails());

    expect(decisionFn).toHaveBeenCalledWith(
      ui,
      "Permission Required",
      "Allow read?",
      undefined,
      expect.any(AbortSignal),
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
      expect.any(String),
      { sessionLabel: "Yes, for 'read' tool" },
      expect.any(AbortSignal),
    );
  });

  it("emits the UI event before calling requestPermissionDecisionFromUi", async () => {
    const calls: string[] = [];
    const events = {
      emit: vi.fn(() => {
        calls.push("emit");
      }),
      on: vi.fn().mockReturnValue(() => undefined),
    };
    const ui = { select: vi.fn(), input: vi.fn() };
    const decisionFn = vi.fn<typeof requestPermissionDecisionFromUi>(() => {
      calls.push("dialog");
      return Promise.resolve({ approved: true, state: "approved" });
    });
    const authorizer = new LocalUserAuthorizer({
      ui,
      events,
      queue: new SerialInteractivePromptQueue(),
      requestPermissionDecisionFromUi: decisionFn,
    });

    await authorizer.authorize(makeDetails());

    expect(calls).toEqual(["emit", "dialog"]);
  });

  describe("forwarded provenance", () => {
    it("serializes concurrent direct and forwarded authorization", async () => {
      const directDecision = Promise.withResolvers<PermissionPromptDecision>();
      const forwardedDecision =
        Promise.withResolvers<PermissionPromptDecision>();
      const { deps, events, decisionFn } = makeDeps({
        requestPermissionDecisionFromUi: vi
          .fn<typeof requestPermissionDecisionFromUi>()
          .mockImplementationOnce(() => directDecision.promise)
          .mockImplementationOnce(() => forwardedDecision.promise),
      });
      const authorizer = new LocalUserAuthorizer(deps);

      const directResult = authorizer.authorize(
        makeDetails({ requestId: "direct" }),
      );
      const forwardedResult = authorizer.authorize(
        makeDetails({
          requestId: "forwarded",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );
      await Promise.resolve();

      expect(events.emit).toHaveBeenCalledOnce();
      expect(decisionFn).toHaveBeenCalledOnce();
      expect(decisionFn).toHaveBeenLastCalledWith(
        expect.anything(),
        "Permission Required",
        "Allow read?",
        undefined,
        expect.any(AbortSignal),
      );

      directDecision.resolve({ approved: true, state: "approved" });
      await directResult;
      await Promise.resolve();

      expect(events.emit).toHaveBeenCalledTimes(2);
      expect(decisionFn).toHaveBeenCalledTimes(2);
      expect(decisionFn).toHaveBeenLastCalledWith(
        expect.anything(),
        "Permission Required (Subagent)",
        "Allow read?",
        undefined,
        expect.any(AbortSignal),
      );

      forwardedDecision.resolve({ approved: false, state: "denied" });
      await expect(forwardedResult).resolves.toEqual({
        approved: false,
        state: "denied",
      });
    });

    it("emits a non-degraded forwarded event with populated forwarding and the child's display projection", async () => {
      const { deps, events } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          source: "tool_call",
          agentName: "Explore",
          message:
            "Subagent 'Explore' requested permission.\n\nAllow git push?",
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
        message: "Subagent 'Explore' requested permission.\n\nAllow git push?",
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      });
    });

    it("uses the '(Subagent)' dialog title when the ask is forwarded", async () => {
      const { deps, ui, decisionFn } = makeDeps();
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
        ui,
        "Permission Required (Subagent)",
        "Allow read?",
        undefined,
        expect.any(AbortSignal),
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
        expect.any(String),
        {
          sessionScope: {
            subagentLabel: "This subagent ('Explore') only",
            servingSessionLabel:
              'The whole session — allow bash "git *" for parent and all subagents',
          },
        },
        expect.any(AbortSignal),
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
        expect.any(String),
        undefined,
        expect.any(AbortSignal),
      );
    });
  });

  it("returns the decision from requestPermissionDecisionFromUi", async () => {
    const decision: PermissionPromptDecision = {
      approved: false,
      state: "denied",
    };
    const { deps } = makeDeps({
      requestPermissionDecisionFromUi: vi
        .fn<typeof requestPermissionDecisionFromUi>()
        .mockResolvedValue(decision),
    });
    const authorizer = new LocalUserAuthorizer(deps);

    const result = await authorizer.authorize(makeDetails());

    expect(result).toEqual(decision);
  });
});
