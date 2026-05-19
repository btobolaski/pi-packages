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

export interface PreToolUseHookInput {
  session_id: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  transcript_path: string;
}

export type HookPermissionDecision = "allow" | "deny" | "ask" | "defer";

export interface PreToolUseHookSpecificOutput {
  hookEventName?: string;
  permissionDecision?: HookPermissionDecision;
  permissionDecisionReason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
}

export interface PreToolUseHookOutput {
  hookSpecificOutput?: PreToolUseHookSpecificOutput;
}

// Internal results emitted by the hook executor / runner.

export interface PreToolUseHookResult {
  decision: HookPermissionDecision;
  reason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
  stderr?: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface MergedHookDecision {
  decision: HookPermissionDecision;
  reasons: string[];
  updatedInput?: unknown;
  additionalContext?: string;
}

export interface HookExecutionContext {
  session_id: string;
  cwd: string;
  permission_mode: string;
  transcript_path: string;
}
