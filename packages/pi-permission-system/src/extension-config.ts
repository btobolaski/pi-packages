import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { UnifiedPermissionConfig } from "./config-loader";
import { normalizeHooksConfig } from "./hook-normalize";
import type { HooksConfig } from "./hook-types";

export const EXTENSION_ID = "pi-permission-system";

export interface PermissionSystemExtensionConfig {
  debugLog: boolean;
  permissionReviewLog: boolean;
  yoloMode: boolean;
  /** Auto-approve edit/write tool checks for paths inside the working directory. */
  allowLocalEdits: boolean;
  /** Auto-approve web search and enable per-domain fetch_content prompts. */
  allowWebAccess: boolean;
  /** Persistently approved fetch_content hostnames. */
  allowedFetchDomains: string[];
  /** Normalized Claude Code-compatible lifecycle hooks. */
  hooks?: HooksConfig;
  /** Additional directories to auto-allow for reads as Pi infrastructure. */
  piInfrastructureReadPaths?: string[];
  /** Max length of the inline-JSON input preview shown in permission prompts. Defaults to 200. */
  toolInputPreviewMaxLength?: number;
  /** Max length of inline pattern/path summaries (grep/find/ls) in permission prompts. Defaults to 80. */
  toolTextSummaryMaxLength?: number;
}

export const DEFAULT_EXTENSION_CONFIG: PermissionSystemExtensionConfig = {
  debugLog: false,
  permissionReviewLog: true,
  yoloMode: false,
  allowLocalEdits: false,
  allowWebAccess: false,
  allowedFetchDomains: [],
};

function resolveExtensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();

const PERMISSION_POLICY_KEYS: ReadonlySet<string> = new Set([
  "defaultPolicy",
  "tools",
  "bash",
  "mcp",
  "skills",
  "special",
  "external_directory",
]);

export function detectMisplacedPermissionKeys(
  raw: Record<string, unknown>,
): string[] {
  return Object.keys(raw).filter((key) => PERMISSION_POLICY_KEYS.has(key));
}

export function normalizePermissionSystemConfig(
  raw: UnifiedPermissionConfig,
): PermissionSystemExtensionConfig {
  const result: PermissionSystemExtensionConfig = {
    debugLog: raw.debugLog === true,
    permissionReviewLog: raw.permissionReviewLog !== false,
    yoloMode: raw.yoloMode === true,
    allowLocalEdits: raw.allowLocalEdits === true,
    allowWebAccess: raw.allowWebAccess === true,
    allowedFetchDomains: normalizeAllowedFetchDomains(
      raw.allowedFetchDomains ?? [],
    ),
  };
  const hooks = normalizeHooksConfig(raw.hooks);
  if (hooks !== undefined) {
    result.hooks = hooks;
  }
  if (raw.piInfrastructureReadPaths !== undefined) {
    result.piInfrastructureReadPaths = raw.piInfrastructureReadPaths;
  }
  if (raw.toolInputPreviewMaxLength !== undefined) {
    result.toolInputPreviewMaxLength = raw.toolInputPreviewMaxLength;
  }
  if (raw.toolTextSummaryMaxLength !== undefined) {
    result.toolTextSummaryMaxLength = raw.toolTextSummaryMaxLength;
  }
  return result;
}

function normalizeAllowedFetchDomains(domains: readonly string[]): string[] {
  return [
    ...new Set(
      domains
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain.length > 0),
    ),
  ];
}

export function isYoloModeEnabled(
  config: PermissionSystemExtensionConfig,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- typed as boolean but may be undefined at runtime (untyped callers); Boolean() guards against that
  return Boolean(config.yoloMode);
}

export function ensurePermissionSystemLogsDirectory(
  logsDir: string,
): string | undefined {
  try {
    mkdirSync(logsDir, { recursive: true });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to create permission-system log directory '${logsDir}': ${message}`;
  }
}
