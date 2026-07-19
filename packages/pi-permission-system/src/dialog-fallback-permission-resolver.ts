import type {
  AccessIntent,
  PathValuesAccessIntent,
} from "#src/access-intent/access-intent";
import type { PermissionResolver } from "#src/permission-resolver";
import type { Rule } from "#src/rule";
import type { SkillPermissionChecker } from "#src/skill-prompt-sanitizer";
import type { PermissionCheckResult, PermissionState } from "#src/types";

/**
 * Resolver used by the hooks-first runtime.
 *
 * Configured policy remains available for inspection, but it does not decide
 * whether a tool runs. A user-granted session rule is retained; every other
 * result becomes an ask that reaches the terminal authorizer.
 */
export class DialogFallbackPermissionResolver
  implements SkillPermissionChecker
{
  constructor(private readonly delegate: PermissionResolver) {}

  resolve(
    intent: AccessIntent | PathValuesAccessIntent,
  ): PermissionCheckResult {
    return requireDialogUnlessSessionApproved(this.delegate.resolve(intent));
  }

  checkPermission(
    surface: string,
    input: unknown,
    agentName?: string,
    sessionRules?: Rule[],
  ): PermissionCheckResult {
    return requireDialogUnlessSessionApproved(
      this.delegate.checkPermission(surface, input, agentName, sessionRules),
    );
  }

  getToolPermission(_toolName: string, _agentName?: string): PermissionState {
    return "ask";
  }
}

function requireDialogUnlessSessionApproved(
  check: PermissionCheckResult,
): PermissionCheckResult {
  if (check.source === "session") {
    return check;
  }
  return {
    ...check,
    state: "ask",
    reason: undefined,
    matchedPattern: undefined,
    origin: "dialog-fallback",
  };
}
