import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import {
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { loadAndMergeConfigs, loadRawUnifiedConfigJson } from "./config-loader";
import {
  DEBUG_LOG_FILENAME,
  getGlobalConfigPath,
  getLegacyExtensionConfigPath,
  getLegacyGlobalPolicyPath,
  getLegacyProjectPolicyPath,
  getProjectConfigPath,
  REVIEW_LOG_FILENAME,
} from "./config-paths";
import { buildResolvedConfigLogEntry } from "./config-reporter";
import {
  DEFAULT_EXTENSION_CONFIG,
  EXTENSION_ROOT,
  ensurePermissionSystemLogsDirectory,
  normalizePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "./extension-config";
import { computeExtensionPaths, type ExtensionPaths } from "./extension-paths";

export type { ExtensionPaths } from "./extension-paths";

import { createPermissionSystemLogger } from "./logging";
import { PermissionManager } from "./permission-manager";
import { SessionRules } from "./session-rules";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer";
import { syncPermissionSystemStatus } from "./status";

/**
 * Mutable session state — the subset of ExtensionRuntime that holds
 * per-session fields. `PermissionSession` now owns these for handler
 * use; this interface remains so `ExtensionRuntime` can still serve
 * as the internal composition root (config-modal, RPC handlers).
 */
interface SessionState {
  runtimeContext: ExtensionContext | null;
  permissionManager: PermissionManager;
  readonly sessionRules: SessionRules;
  activeSkillEntries: SkillPromptEntry[];
  lastKnownActiveAgentName: string | null;
  lastActiveToolsCacheKey: string | null;
  lastPromptStateCacheKey: string | null;
}

/**
 * Runtime context object created once inside `piPermissionSystemExtension()`.
 *
 * Holds all path constants (derived from `getAgentDir()` at construction time),
 * mutable extension state, and the log-writing methods — eliminating the
 * module-scope cached constants and setter-injection pattern that previously
 * lived in `src/index.ts`.
 *
 * Tests construct this via `createExtensionRuntime({ agentDir: tmpDir })`
 * without timing issues around `PI_CODING_AGENT_DIR`.
 */
export interface ExtensionRuntime extends ExtensionPaths, SessionState {
  // ── Mutable state (beyond SessionState) ───────────────────────────────────
  config: PermissionSystemExtensionConfig;
  lastConfigWarning: string | null;

  // ── Logging (backed by logger created at construction) ─────────────────
  writeDebugLog(event: string, details?: Record<string, unknown>): void;
  writeReviewLog(event: string, details?: Record<string, unknown>): void;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Derive Pi project-level config and agents paths from a working directory.
 * Returns null when cwd is absent (headless / global-only config).
 */
export function derivePiProjectPaths(cwd: string | undefined | null): {
  projectGlobalConfigPath: string;
  projectAgentsDir: string;
} | null {
  if (!cwd) {
    return null;
  }
  return {
    projectGlobalConfigPath: getProjectConfigPath(cwd),
    projectAgentsDir: join(cwd, ".pi", "agent", "agents"),
  };
}

/**
 * Create a new PermissionManager scoped to a working directory's config hierarchy.
 * Pass `cwd` as null/undefined to use global config only.
 */
export function createPermissionManagerForCwd(
  agentDir: string,
  cwd: string | undefined | null,
): PermissionManager {
  const projectPaths = derivePiProjectPaths(cwd);
  return new PermissionManager({
    globalConfigPath: getGlobalConfigPath(agentDir),
    projectGlobalConfigPath: projectPaths?.projectGlobalConfigPath,
    projectAgentsDir: projectPaths?.projectAgentsDir,
  });
}

/**
 * Reload merged config from disk into the runtime.
 * If `ctx` is provided, updates `runtime.runtimeContext` first.
 */
export function refreshExtensionConfig(
  runtime: ExtensionRuntime,
  ctx?: ExtensionContext,
): void {
  if (ctx) {
    runtime.runtimeContext = ctx;
  }
  const cwd = runtime.runtimeContext?.cwd ?? null;
  const mergeResult = loadAndMergeConfigs(
    runtime.agentDir,
    cwd ?? "",
    EXTENSION_ROOT,
  );
  const runtimeConfig = normalizePermissionSystemConfig(mergeResult.merged);
  runtime.config = runtimeConfig;

  if (runtime.runtimeContext?.hasUI) {
    syncPermissionSystemStatus(runtime.runtimeContext, runtimeConfig);
  }

  const warning =
    mergeResult.issues.length > 0 ? mergeResult.issues.join("\n") : undefined;

  if (warning && warning !== runtime.lastConfigWarning) {
    runtime.lastConfigWarning = warning;
    runtime.runtimeContext?.ui.notify(warning, "warning");
  } else if (!warning) {
    runtime.lastConfigWarning = null;
  }

  runtime.writeDebugLog("config.loaded", {
    warning: warning ?? null,
    debugLog: runtimeConfig.debugLog,
    permissionReviewLog: runtimeConfig.permissionReviewLog,
    yoloMode: runtimeConfig.yoloMode,
    allowLocalEdits: runtimeConfig.allowLocalEdits,
    allowWebAccess: runtimeConfig.allowWebAccess,
    allowedFetchDomains: runtimeConfig.allowedFetchDomains,
  });
}

/**
 * Save updated runtime knobs to the global config file, then update
 * `runtime.config` and sync UI status.
 *
 * Persists `debugLog`, `permissionReviewLog`, `yoloMode`, `allowLocalEdits`,
 * `allowWebAccess`, and `allowedFetchDomains`. Other fields already present in
 * the on-disk config (e.g. `permission`, `hooks`, `piInfrastructureReadPaths`)
 * are preserved unchanged.
 *
 * Returns `true` when the write succeeded, `false` when it failed. On failure
 * the UI is notified and `runtime.config` is left untouched so callers can
 * decide on a fallback (e.g. session-only allow).
 */
export function saveExtensionConfig(
  runtime: ExtensionRuntime,
  next: PermissionSystemExtensionConfig,
  ctx: ExtensionCommandContext,
): boolean {
  const normalized = normalizePermissionSystemConfig(next);
  const globalPath = getGlobalConfigPath(runtime.agentDir);

  // Read the raw on-disk JSON rather than the normalized config: the normalized
  // form carries compiled `matcherRegex: RegExp` instances inside `hooks` that
  // would serialize to `{}` and corrupt a previously-valid hooks block.
  const existing = loadRawUnifiedConfigJson(globalPath);
  const merged = {
    ...existing,
    debugLog: normalized.debugLog,
    permissionReviewLog: normalized.permissionReviewLog,
    yoloMode: normalized.yoloMode,
    allowLocalEdits: normalized.allowLocalEdits,
    allowWebAccess: normalized.allowWebAccess,
    allowedFetchDomains: normalized.allowedFetchDomains,
  };

  const tmpPath = `${globalPath}.tmp`;
  try {
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, globalPath);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup failures.
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `Failed to save permission-system config at '${globalPath}': ${message}`,
      "error",
    );
    return false;
  }

  runtime.config = normalized;
  syncPermissionSystemStatus(ctx, normalized);
  runtime.lastConfigWarning = null;

  runtime.writeDebugLog("config.saved", {
    debugLog: normalized.debugLog,
    permissionReviewLog: normalized.permissionReviewLog,
    yoloMode: normalized.yoloMode,
    allowLocalEdits: normalized.allowLocalEdits,
    allowWebAccess: normalized.allowWebAccess,
    allowedFetchDomains: normalized.allowedFetchDomains,
  });

  return true;
}

/**
 * Write the resolved config path set (global, project, legacy) to the review
 * and debug logs.
 */
export function logResolvedConfigPaths(runtime: ExtensionRuntime): void {
  const policyPaths = runtime.permissionManager.getResolvedPolicyPaths();
  const cwd = runtime.runtimeContext?.cwd ?? null;
  const { agentDir } = runtime;
  const legacyGlobalPolicyDetected = existsSync(
    getLegacyGlobalPolicyPath(agentDir),
  );
  const legacyProjectPolicyDetected = cwd
    ? existsSync(getLegacyProjectPolicyPath(cwd))
    : false;
  const legacyExtConfigPath = getLegacyExtensionConfigPath(EXTENSION_ROOT);
  const newGlobalPath = getGlobalConfigPath(agentDir);
  const legacyExtensionConfigDetected =
    normalize(legacyExtConfigPath) !== normalize(newGlobalPath) &&
    existsSync(legacyExtConfigPath);
  const entry = buildResolvedConfigLogEntry({
    policyPaths,
    legacyGlobalPolicyDetected,
    legacyProjectPolicyDetected,
    legacyExtensionConfigDetected,
  });
  runtime.writeReviewLog(
    "config.resolved",
    entry as unknown as Record<string, unknown>,
  );
  runtime.writeDebugLog(
    "config.resolved",
    entry as unknown as Record<string, unknown>,
  );
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a fully-initialized `ExtensionRuntime`.
 *
 * Calls `getAgentDir()` at invocation time (never at module scope), so tests
 * may set `PI_CODING_AGENT_DIR` before calling the factory.
 */
export function createExtensionRuntime(options?: {
  agentDir?: string;
}): ExtensionRuntime {
  const agentDir = options?.agentDir ?? getAgentDir();
  const paths = computeExtensionPaths(agentDir);

  // Build a plain-object runtime first so the logger's `getConfig` closure
  // can reference `runtime.config` directly (always reads current value).
  const runtime: ExtensionRuntime = {
    ...paths,
    config: { ...DEFAULT_EXTENSION_CONFIG },
    runtimeContext: null,
    permissionManager: createPermissionManagerForCwd(agentDir, undefined),
    activeSkillEntries: [],
    lastKnownActiveAgentName: null,
    lastActiveToolsCacheKey: null,
    lastPromptStateCacheKey: null,
    lastConfigWarning: null,
    sessionRules: new SessionRules(),
    // Logging methods are replaced below after the logger is constructed.
    writeDebugLog: () => {},
    writeReviewLog: () => {},
  };

  const reportedLoggingWarnings = new Set<string>();
  const logger = createPermissionSystemLogger({
    // Reads runtime.config at call time — always current.
    getConfig: () => runtime.config,
    debugLogPath: join(paths.globalLogsDir, DEBUG_LOG_FILENAME),
    reviewLogPath: join(paths.globalLogsDir, REVIEW_LOG_FILENAME),
    ensureLogsDirectory: () =>
      ensurePermissionSystemLogsDirectory(paths.globalLogsDir),
  });

  const reportLoggingWarning = (message: string): void => {
    if (reportedLoggingWarnings.has(message)) {
      return;
    }
    reportedLoggingWarnings.add(message);
    // Reads runtime.runtimeContext at call time — always current.
    runtime.runtimeContext?.ui.notify(message, "warning");
  };

  runtime.writeDebugLog = (
    event: string,
    details: Record<string, unknown> = {},
  ): void => {
    const warning = logger.debug(event, details);
    if (warning) {
      reportLoggingWarning(warning);
    }
  };

  runtime.writeReviewLog = (
    event: string,
    details: Record<string, unknown> = {},
  ): void => {
    const warning = logger.review(event, details);
    if (warning) {
      reportLoggingWarning(warning);
    }
  };

  return runtime;
}
