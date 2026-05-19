import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccessPath } from "#src/access-intent/access-path";
import { BashProgram } from "#src/access-intent/bash/program";
import { classifyToolKind } from "#src/access-intent/tool-kind";
import type { ToolCheckOverrides } from "#src/handlers/tool-call-overrides";
import type { PathNormalizer } from "#src/path-normalizer";
import type { ScopedPermissionResolver } from "#src/permission-resolver";
import type { SkillPromptEntry } from "#src/skill-prompt-sanitizer";
import type { ToolAccessExtractorLookup } from "#src/tool-access-extractor-registry";
import type { ToolInputFormatterLookup } from "#src/tool-input-formatter-registry";
import { getPathBearingToolPath } from "#src/tool-input-path";
import {
  ToolPreviewFormatter,
  type ToolPreviewFormatterOptions,
} from "#src/tool-preview-formatter";
import type { PathRuleTokenMatcher, PermissionCheckResult } from "#src/types";
import { getNonEmptyString, toRecord } from "#src/value-guards";
import { resolveBashCommandCheck } from "./bash-command";
import { describeBashExternalDirectoryGate } from "./bash-external-directory";
import { describeBashPathGate } from "./bash-path";
import type { GateResult } from "./descriptor";
import { describeExternalDirectoryGate } from "./external-directory";
import { describePathGate } from "./path";
import type { GateRunner } from "./runner";
import { describeSkillReadGate } from "./skill-read";
import { describeToolGate } from "./tool";
import type { GateOutcome, ToolCallContext } from "./types";

/**
 * Narrow interface the pipeline needs from its session-side dependency.
 *
 * The three query methods needed to assemble gate inputs.
 * The resolver is injected separately as a constructor parameter.
 *
 * `PermissionSession` satisfies this structurally at the construction call
 * site; no `implements` clause is needed and would create a layer-inversion
 * import from the domain module into the handler layer.
 */
export interface ToolCallGateInputs {
  /** Active skill prompt entries for the skill-read gate. */
  getActiveSkillEntries(): SkillPromptEntry[];
  /** Combined infrastructure read directories (static + config-derived). */
  getInfrastructureReadDirs(): string[];
  /** Resolved tool-preview formatter options from the current config. */
  getToolPreviewLimits(): ToolPreviewFormatterOptions;
  /** The session's path normalizer (platform + cwd baked in). */
  getPathNormalizer(): PathNormalizer;
  /**
   * Predicate deciding whether a bare bash token should be promoted into the
   * `path` rule-candidate surface (#509), scoped to the given agent.
   */
  getPromotablePathTokenMatcher(agentName?: string): PathRuleTokenMatcher;
}

/**
 * Owns the ordered tool-call gate-producer assembly and the run loop.
 *
 * Constructed once in the composition root and injected into
 * `PermissionGateHandler`. `evaluate(tcc, runner)` encapsulates:
 * - bash-command extraction and single `BashProgram.parse` (#308)
 * - `ToolPreviewFormatter` construction from `getToolPreviewLimits()`
 * - infrastructure-dir list from `getInfrastructureReadDirs()`
 * - all six gate producers in their prescribed order
 * - the run loop that returns the first block outcome, or allow
 */
export class ToolCallGatePipeline {
  constructor(
    private readonly resolver: ScopedPermissionResolver,
    private readonly inputs: ToolCallGateInputs,
    private readonly customFormatters?: ToolInputFormatterLookup,
    private readonly customExtractors?: ToolAccessExtractorLookup,
    private readonly overrides?: ToolCheckOverrides,
  ) {}

  async evaluate(
    tcc: ToolCallContext,
    runner: GateRunner,
    ctx?: ExtensionContext,
  ): Promise<GateOutcome> {
    // Parse the bash command exactly once per evaluate; the three bash gates
    // share this single BashProgram instead of each re-parsing (#308).
    const command = getNonEmptyString(toRecord(tcc.input).command);
    const normalizer = this.inputs.getPathNormalizer();
    const bashProgram =
      classifyToolKind(tcc.toolName) === "bash" && command
        ? await BashProgram.parse(
            command,
            normalizer,
            this.inputs.getPromotablePathTokenMatcher(
              tcc.agentName ?? undefined,
            ),
          )
        : null;

    const formatter = new ToolPreviewFormatter(
      this.inputs.getToolPreviewLimits(),
      this.customFormatters,
    );

    const infraDirs = this.inputs.getInfrastructureReadDirs();

    const gateProducers: Array<() => GateResult | Promise<GateResult>> = [
      () =>
        describeSkillReadGate(tcc, normalizer, () =>
          this.inputs.getActiveSkillEntries(),
        ),
      () =>
        describePathGate(tcc, this.resolver, normalizer, this.customExtractors),
      () =>
        describeExternalDirectoryGate(
          tcc,
          infraDirs,
          this.resolver,
          normalizer,
          this.customExtractors,
        ),
      () => describeBashExternalDirectoryGate(tcc, bashProgram, this.resolver),
      () => describeBashPathGate(tcc, bashProgram, this.resolver),
    ];

    for (const produce of gateProducers) {
      const outcome = await runner.run(
        await produce(),
        tcc.agentName,
        tcc.toolCallId,
      );
      if (outcome.action === "block") {
        return outcome;
      }
    }

    const { toolCheck, accessPath } = this.resolvePerToolCheck(
      tcc,
      bashProgram,
      command,
      normalizer,
    );
    const overrideOutcome =
      this.overrides && ctx
        ? await this.overrides.apply(tcc, ctx, toolCheck, formatter)
        : { action: "continue" as const, check: toolCheck };
    if (overrideOutcome.action !== "continue") {
      return overrideOutcome;
    }

    const toolDescriptor = describeToolGate(
      tcc,
      overrideOutcome.check,
      formatter,
      accessPath,
    );
    toolDescriptor.preCheck = overrideOutcome.check;
    return await runner.run(toolDescriptor, tcc.agentName, tcc.toolCallId);
  }

  /**
   * Resolve the per-tool gate's check, choosing the intent by tool shape:
   * bash chains its sub-commands; a path-bearing tool with a path emits an
   * `access-path` intent (so the per-tool surface matches lexical ∪ canonical,
   * #502); every other tool (and a path-bearing tool with no path) keeps the
   * raw `tool` intent the manager normalizes.
   *
   * Returns the `AccessPath` alongside the check so `describeToolGate` derives
   * the session-approval value from `accessPath.value()`.
   */
  private resolvePerToolCheck(
    tcc: ToolCallContext,
    bashProgram: BashProgram | null,
    command: string | null,
    normalizer: PathNormalizer,
  ): { toolCheck: PermissionCheckResult; accessPath?: AccessPath } {
    if (classifyToolKind(tcc.toolName) === "bash" && bashProgram) {
      return {
        toolCheck: resolveBashCommandCheck(
          command ?? "",
          bashProgram.commands(),
          tcc.agentName ?? undefined,
          this.resolver,
        ),
      };
    }

    const filePath = getPathBearingToolPath(tcc.toolName, tcc.input);
    if (filePath !== null) {
      const accessPath = normalizer.forPath(filePath);
      return {
        accessPath,
        toolCheck: this.resolver.resolve({
          kind: "access-path",
          surface: tcc.toolName,
          path: accessPath,
          agentName: tcc.agentName ?? undefined,
        }),
      };
    }

    return {
      toolCheck: this.resolver.resolve({
        kind: "tool",
        surface: tcc.toolName,
        input: tcc.input,
        agentName: tcc.agentName ?? undefined,
      }),
    };
  }
}
