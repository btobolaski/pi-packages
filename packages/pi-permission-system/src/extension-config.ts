import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toRecord } from "./common";

export const EXTENSION_ID = "pi-permission-system";

export interface PermissionSystemExtensionConfig {
  debugLog: boolean;
  permissionReviewLog: boolean;
  yoloMode: boolean;
  /**
   * Auto-approve `edit` and `write` calls that target a path inside the
   * current working directory, even when a deny rule would otherwise apply.
   */
  allowLocalEdits: boolean;
  /**
   * Auto-approve web search tools and present a per-domain dialog for
   * `fetch_content`. Persisted domain approvals live in
   * `allowedFetchDomains`.
   */
  allowWebAccess: boolean;
  /** Hostnames that auto-approve `fetch_content`. Persisted via "always allow". */
  allowedFetchDomains: string[];
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

/** Returns `raw` if it is a positive integer; otherwise `undefined`. */
export function normalizeOptionalPositiveInt(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0
    ? raw
    : undefined;
}

function normalizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  if (!raw.every((value): value is string => typeof value === "string")) {
    return undefined;
  }
  return raw;
}

function normalizeAllowedFetchDomains(raw: unknown): string[] {
  const list = normalizeStringArray(raw);
  if (!list) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of list) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function normalizePermissionSystemConfig(
  raw: unknown,
): PermissionSystemExtensionConfig {
  const record = toRecord(raw);
  const piInfrastructureReadPaths = normalizeStringArray(
    record.piInfrastructureReadPaths,
  );
  const result: PermissionSystemExtensionConfig = {
    debugLog: record.debugLog === true,
    permissionReviewLog: record.permissionReviewLog !== false,
    yoloMode: record.yoloMode === true,
    allowLocalEdits: record.allowLocalEdits === true,
    allowWebAccess: record.allowWebAccess === true,
    allowedFetchDomains: normalizeAllowedFetchDomains(
      record.allowedFetchDomains,
    ),
  };
  if (piInfrastructureReadPaths !== undefined) {
    result.piInfrastructureReadPaths = piInfrastructureReadPaths;
  }
  const toolInputPreviewMaxLength = normalizeOptionalPositiveInt(
    record.toolInputPreviewMaxLength,
  );
  if (toolInputPreviewMaxLength !== undefined) {
    result.toolInputPreviewMaxLength = toolInputPreviewMaxLength;
  }
  const toolTextSummaryMaxLength = normalizeOptionalPositiveInt(
    record.toolTextSummaryMaxLength,
  );
  if (toolTextSummaryMaxLength !== undefined) {
    result.toolTextSummaryMaxLength = toolTextSummaryMaxLength;
  }
  return result;
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
