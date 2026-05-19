export type PermissionState = "allow" | "deny" | "ask";

import type { RuleOrigin } from "./rule";

export type { RuleOrigin };

/**
 * The on-disk permission shape inside the `"permission"` key.
 * Each key is a surface name; values are either a PermissionState string
 * (shorthand for `{ "*": action }`) or a pattern→action map.
 */
export type FlatPermissionConfig = Record<
  string,
  PermissionState | Record<string, PermissionState>
>;

/**
 * Per-scope permission config shape after loading and validation.
 * Holds the flat permission map and (global-scope only) PreToolUse hooks.
 */
export interface ScopeConfig {
  permission?: FlatPermissionConfig;
  hooks?: import("./hook-types").HooksConfig;
}

/**
 * Execution context of a bash command nested inside a substitution or subshell.
 * Absent for current-shell (top-level) commands.
 */
export type BashCommandContext =
  | "command_substitution"
  | "process_substitution"
  | "subshell";

export interface PermissionCheckResult {
  toolName: string;
  state: PermissionState;
  matchedPattern?: string;
  command?: string;
  target?: string;
  source: "tool" | "bash" | "mcp" | "skill" | "special" | "default" | "session";
  /** Which source contributed the winning rule. */
  origin: RuleOrigin;
  /**
   * Execution context of the offending nested command, when the winning bash
   * unit came from a substitution or subshell. Absent for current-shell
   * (top-level) commands.
   */
  commandContext?: BashCommandContext;
}
