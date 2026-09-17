/** Outcome of a single permission gate evaluation. */
export type GateOutcome =
  | { action: "allow" }
  | { action: "block"; reason: string };

/** One lifetime view; consumers do not reconstruct cancellation from its parts. */
export interface PermissionRequestLifetime {
  readonly signal?: AbortSignal;
  isActive(): boolean;
}

/** Non-tool callers have no originating tool-call lifetime. */
export const UNINTERRUPTED_REQUEST: PermissionRequestLifetime = Object.freeze({
  isActive: () => true,
});

/** Pre-validated context shared across all gates. */
export interface ToolCallContext {
  toolName: string;
  agentName: string | null;
  input: unknown;
  toolCallId: string;
  cwd: string;
  lifetime: PermissionRequestLifetime;
}
