import type {
  HooksConfig,
  PreToolUseHookCommand,
  PreToolUseHookMatcher,
} from "#src/hook-types";
import { toRecord } from "#src/value-guards";

/** Normalize a raw hook command into `PreToolUseHookCommand`, or null when invalid. */
export function normalizeHookCommand(
  raw: unknown,
): PreToolUseHookCommand | null {
  const record = toRecord(raw);
  if (
    record.type !== "command" ||
    typeof record.command !== "string" ||
    !record.command.trim()
  ) {
    return null;
  }
  const result: PreToolUseHookCommand = {
    type: "command",
    command: record.command.trim(),
  };
  if (typeof record.if === "string" && record.if.trim()) {
    result.if = record.if.trim();
  }
  if (typeof record.timeout === "number" && record.timeout > 0) {
    result.timeout = record.timeout;
  }
  return result;
}

/**
 * Normalize a raw matcher entry, compiling its `matcher` string into a
 * `^(?:…)$` regex. Returns null when the matcher is empty, the regex is
 * invalid, or no valid hook commands survive normalization.
 */
export function normalizeHookMatcher(
  raw: unknown,
): PreToolUseHookMatcher | null {
  const record = toRecord(raw);
  if (typeof record.matcher !== "string" || !record.matcher.trim()) {
    return null;
  }
  let matcherRegex: RegExp;
  try {
    matcherRegex = new RegExp(`^(?:${record.matcher.trim()})$`);
  } catch {
    return null;
  }
  if (!Array.isArray(record.hooks)) {
    return null;
  }
  const hooks: PreToolUseHookCommand[] = [];
  for (const hookRaw of record.hooks) {
    const hook = normalizeHookCommand(hookRaw);
    if (hook) {
      hooks.push(hook);
    }
  }
  if (hooks.length === 0) {
    return null;
  }
  return { matcher: record.matcher.trim(), matcherRegex, hooks };
}

/**
 * Normalize a raw hooks configuration block (e.g. `{ PreToolUse: [...] }`).
 * Returns undefined when no valid matchers remain.
 */
export function normalizeHooksConfig(raw: unknown): HooksConfig | undefined {
  const record = toRecord(raw);
  const preToolUseRaw = record.PreToolUse;
  if (!Array.isArray(preToolUseRaw)) {
    return undefined;
  }
  const matchers: PreToolUseHookMatcher[] = [];
  for (const matcherRaw of preToolUseRaw) {
    const matcher = normalizeHookMatcher(matcherRaw);
    if (matcher) {
      matchers.push(matcher);
    }
  }
  if (matchers.length === 0) {
    return undefined;
  }
  return { PreToolUse: matchers };
}
