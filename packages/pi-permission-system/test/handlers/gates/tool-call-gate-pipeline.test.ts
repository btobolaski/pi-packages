import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessPath } from "#src/access-intent/access-path";
import { ToolCallGatePipeline } from "#src/handlers/gates/tool-call-gate-pipeline";
import { PathNormalizer } from "#src/path-normalizer";

import {
  makeGateInputs,
  makeGateRunner,
  makeResolver,
  makeTcc,
} from "#test/helpers/gate-fixtures";
import { makeCheckResult, makeCtx } from "#test/helpers/handler-fixtures";

// ── BashProgram.parse mock ─────────────────────────────────────────────────

const { mockBashProgramParse } = vi.hoisted(() => ({
  mockBashProgramParse: vi.fn(),
}));

vi.mock("#src/access-intent/bash/program", () => ({
  BashProgram: { parse: mockBashProgramParse },
}));

// Mock node:fs so realpathSync (used by canonicalizePath) is controllable for
// the per-tool symlink-resolution test. Default implementation is identity.
const realpathSync = vi.hoisted(() =>
  vi.fn<(path: string) => string>((p) => p),
);
vi.mock("node:fs", () => ({
  realpathSync,
  default: { realpathSync },
}));

function makeMockBashProgram() {
  return {
    commands: vi.fn<() => []>(() => []),
    pathRuleCandidates: vi.fn<() => []>(() => []),
    externalPaths: vi.fn<() => AccessPath[]>(() => []),
  };
}

// ── ToolCallGatePipeline ───────────────────────────────────────────────────

describe("ToolCallGatePipeline", () => {
  beforeEach(() => {
    mockBashProgramParse.mockReset();
    mockBashProgramParse.mockResolvedValue(makeMockBashProgram());
    realpathSync.mockReset();
    realpathSync.mockImplementation((p: string) => p);
  });

  // ── non-bash tools ───────────────────────────────────────────────────────

  describe("evaluate — non-bash tool", () => {
    it("returns allow when all gates pass", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const result = await pipeline.evaluate(
        makeTcc({ toolName: "read", input: {} }),
        runner,
      );

      expect(result).toEqual({ action: "allow" });
    });

    it("returns block when the tool gate denies", async () => {
      const resolver = makeResolver(
        makeCheckResult({ state: "deny", matchedPattern: "*" }),
      );
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const result = await pipeline.evaluate(
        makeTcc({ toolName: "read", input: {} }),
        runner,
      );

      expect(result).toMatchObject({ action: "block" });
    });

    it("short-circuits after the first blocking gate without evaluating later ones", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const runSpy = vi
        .spyOn(runner, "run")
        .mockResolvedValue({ action: "block", reason: "first gate blocked" });

      const pipeline = new ToolCallGatePipeline(resolver, inputs);
      const result = await pipeline.evaluate(
        makeTcc({ toolName: "read", input: {} }),
        runner,
      );

      expect(result).toEqual({ action: "block", reason: "first gate blocked" });
      // Pipeline looped to the first gate, got block, and stopped.
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it("does not run tool overrides until every cross-cutting gate passes", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      vi.spyOn(runner, "run").mockResolvedValue({
        action: "block",
        reason: "path gate blocked",
      });
      const overrides = { apply: vi.fn() };
      const pipeline = new ToolCallGatePipeline(
        resolver,
        inputs,
        undefined,
        undefined,
        overrides,
      );

      const result = await pipeline.evaluate(
        makeTcc({ toolName: "edit", input: { path: "src/a.ts" } }),
        runner,
        makeCtx(),
      );

      expect(result).toEqual({ action: "block", reason: "path gate blocked" });
      expect(overrides.apply).not.toHaveBeenCalled();
    });

    it("calls getToolPreviewLimits() during evaluate", async () => {
      const getToolPreviewLimits = vi.fn(() => ({
        toolInputPreviewMaxLength: 500,
        toolTextSummaryMaxLength: 100,
        toolInputLogPreviewMaxLength: 200,
      }));
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs({ getToolPreviewLimits });
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(makeTcc({ toolName: "read", input: {} }), runner);

      expect(getToolPreviewLimits).toHaveBeenCalled();
    });

    it("calls getInfrastructureReadDirs() during evaluate", async () => {
      const getInfrastructureReadDirs = vi.fn<() => string[]>(() => []);
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs({ getInfrastructureReadDirs });
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(makeTcc({ toolName: "read", input: {} }), runner);

      expect(getInfrastructureReadDirs).toHaveBeenCalled();
    });

    it("calls getActiveSkillEntries() during evaluate", async () => {
      const getActiveSkillEntries = vi.fn<() => []>(() => []);
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs({ getActiveSkillEntries });
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(makeTcc({ toolName: "read", input: {} }), runner);

      expect(getActiveSkillEntries).toHaveBeenCalled();
    });

    it("does not call BashProgram.parse for non-bash tools", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(makeTcc({ toolName: "read", input: {} }), runner);

      expect(mockBashProgramParse).not.toHaveBeenCalled();
    });
  });

  // ── bash tool ────────────────────────────────────────────────────────────

  describe("evaluate — bash tool", () => {
    it("returns allow when the bash command is permitted", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const result = await pipeline.evaluate(
        makeTcc({ toolName: "bash", input: { command: "echo hello" } }),
        runner,
      );

      expect(result).toEqual({ action: "allow" });
    });

    it("parses BashProgram exactly once per evaluate for bash tools with a command", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(
        makeTcc({ toolName: "bash", input: { command: "echo hello" } }),
        runner,
      );

      expect(mockBashProgramParse).toHaveBeenCalledTimes(1);
      expect(mockBashProgramParse).toHaveBeenCalledWith(
        "echo hello",
        expect.any(PathNormalizer),
        expect.any(Function),
      );
    });

    it("does not parse BashProgram when the bash command is empty", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(
        makeTcc({ toolName: "bash", input: { command: "" } }),
        runner,
      );

      expect(mockBashProgramParse).not.toHaveBeenCalled();
    });

    it("passes the session's promotable path-token matcher into BashProgram.parse (#509)", async () => {
      const resolver = makeResolver(makeCheckResult());
      const isPromotable = vi.fn((token: string) => token === "id_rsa");
      const getPromotablePathTokenMatcher = vi.fn(() => isPromotable);
      const inputs = makeGateInputs({ getPromotablePathTokenMatcher });
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(
        makeTcc({
          toolName: "bash",
          input: { command: "cat id_rsa" },
          agentName: "my-agent",
        }),
        runner,
      );

      expect(getPromotablePathTokenMatcher).toHaveBeenCalledWith("my-agent");
      expect(mockBashProgramParse).toHaveBeenCalledWith(
        "cat id_rsa",
        expect.any(PathNormalizer),
        isPromotable,
      );
    });
  });

  // ── customExtractors threading (#352) ────────────────────────────────────

  describe("evaluate — customExtractors threading (#352)", () => {
    // Deny only the cross-cutting `path` surface; allow everything else, so a
    // block can only come from the path gate seeing the extracted path.
    function pathDenyingResolver() {
      const resolver = makeResolver();
      resolver.resolve.mockImplementation((intent) =>
        intent.surface === "path"
          ? makeCheckResult({ state: "deny", matchedPattern: "*" })
          : makeCheckResult(),
      );
      return resolver;
    }

    const extractors = {
      get: (name: string) =>
        name === "ffgrep"
          ? (input: Record<string, unknown>) =>
              typeof input.target === "string" ? input.target : undefined
          : undefined,
    };

    it("forwards extractors so a custom-shaped tool is path-gated", async () => {
      const resolver = pathDenyingResolver();
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(
        resolver,
        inputs,
        undefined,
        extractors,
      );

      const result = await pipeline.evaluate(
        makeTcc({
          toolName: "ffgrep",
          input: { target: "/test/project/secret.env" },
        }),
        runner,
      );

      expect(result).toMatchObject({ action: "block" });
    });

    it("without extractors the custom-shaped tool is not path-gated", async () => {
      const resolver = pathDenyingResolver();
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const result = await pipeline.evaluate(
        makeTcc({
          toolName: "ffgrep",
          input: { target: "/test/project/secret.env" },
        }),
        runner,
      );

      expect(result).toEqual({ action: "allow" });
    });
  });

  // ── per-tool path-bearing gate (#502) ────────────────────────────────────

  describe("evaluate — per-tool path-bearing gate (#502)", () => {
    it("emits an access-path intent on the tool-name surface for a path-bearing tool", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(
        makeTcc({ toolName: "read", input: { path: "/test/cwd/foo.ts" } }),
        runner,
      );

      const perTool = resolver.resolve.mock.calls.find(
        ([intent]) => intent.surface === "read",
      );
      expect(perTool?.[0].kind).toBe("access-path");
    });

    it("keeps a path-bearing tool with no path on the tool intent", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(makeTcc({ toolName: "read", input: {} }), runner);

      const perTool = resolver.resolve.mock.calls.find(
        ([intent]) => intent.surface === "read",
      );
      expect(perTool?.[0].kind).toBe("tool");
    });

    it("blocks when a per-tool rule matches the symlink-resolved form", async () => {
      // /test/cwd/foo.env is a symlink to /vault/foo.env; the per-tool rule is
      // keyed on the resolved target, which is only reachable via matchValues().
      realpathSync.mockImplementation((p: string) =>
        p === "/test/cwd/foo.env" ? "/vault/foo.env" : p,
      );
      const resolver = makeResolver();
      resolver.resolve.mockImplementation((intent) =>
        intent.kind === "access-path" &&
        intent.surface === "read" &&
        intent.path.matchValues().includes("/vault/foo.env")
          ? makeCheckResult({ state: "deny", matchedPattern: "*.env" })
          : makeCheckResult(),
      );
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const result = await pipeline.evaluate(
        makeTcc({ toolName: "read", input: { path: "/test/cwd/foo.env" } }),
        runner,
      );

      expect(result).toMatchObject({ action: "block" });
    });
  });
});
