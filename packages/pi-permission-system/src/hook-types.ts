// Hook configuration matches the Claude Code `settings.json` PreToolUse format.

export interface PreToolUseHookCommand {
  type: "command";
  if?: string;
  command: string;
  timeout?: number;
}

export interface PreToolUseHookMatcher {
  matcher: string;
  matcherRegex: RegExp;
  hooks: PreToolUseHookCommand[];
}

export interface HooksConfig {
  PreToolUse?: PreToolUseHookMatcher[];
}

// Hook I/O matches the Claude Code PreToolUse protocol.

export type HookPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions";

export interface PreToolUseHookInput {
  session_id: string;
  cwd: string;
  permission_mode: HookPermissionMode;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  transcript_path?: string;
}

export type HookPermissionDecision = "allow" | "deny" | "ask" | "defer";

// Internal results emitted by the hook executor / runner.

export type HookExecutionStatus =
  | "decision"
  | "empty_output"
  | "invalid_output"
  | "nonzero_exit"
  | "spawn_error"
  | "timeout";

export interface PreToolUseHookResult {
  decision: HookPermissionDecision;
  status: HookExecutionStatus;
  reason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
  stderr?: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface HookExecutionDiagnostic {
  decision: HookPermissionDecision;
  status: HookExecutionStatus;
  exitCode: number | null;
  timedOut: boolean;
  hasStderr: boolean;
}

export interface MergedHookDecision {
  decision: HookPermissionDecision;
  reasons: string[];
  diagnostics: HookExecutionDiagnostic[];
  updatedInput?: unknown;
  additionalContext?: string;
}

export interface HookExecutionContext {
  session_id: string;
  cwd: string;
  permission_mode: HookPermissionMode;
  transcript_path?: string;
  useProcessGroup: boolean;
}
