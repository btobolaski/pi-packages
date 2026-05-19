import { toRecord } from "./common";
import type { PermissionSystemExtensionConfig } from "./extension-config";

/** Tools auto-approved by `allowWebAccess` without any per-domain prompt. */
export const WEB_SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "web_search",
  "get_search_content",
]);

/**
 * Full set of tools governed by `allowWebAccess`. Used by `shouldExposeTool`
 * to keep web tools visible even when blanket-denied by policy.
 */
export const WEB_ACCESS_TOOLS: ReadonlySet<string> = new Set([
  "web_search",
  "get_search_content",
  "fetch_content",
]);

/**
 * Extract a normalized lowercase hostname from a tool input record's `url`
 * field. Accepts bare hostnames (treats them as `https://<host>`).
 * Returns null when the input has no usable URL.
 */
export function extractDomainFromUrl(input: unknown): string | null {
  const record = toRecord(input);
  const rawUrl = record.url;
  if (typeof rawUrl !== "string") {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${trimmed}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}

/** True when the tool is one of the web-access governed tools. */
export function isWebAccessTool(toolName: string): boolean {
  return WEB_ACCESS_TOOLS.has(toolName);
}

/**
 * Whether the auto-approve web-search override applies to this call.
 *
 * Returns true only when `allowWebAccess` is enabled AND the tool is in
 * `WEB_SEARCH_TOOLS` (i.e. `web_search` or `get_search_content`).
 */
export function shouldAllowWebSearch(
  toolName: string,
  config: PermissionSystemExtensionConfig,
): boolean {
  return config.allowWebAccess && WEB_SEARCH_TOOLS.has(toolName);
}

/**
 * Whether a `fetch_content` call should be auto-approved because its target
 * domain is already trusted — either persisted in
 * `config.allowedFetchDomains` or temporarily approved for this session via
 * `sessionAllowedDomains`.
 */
export function shouldAllowFetchForDomain(
  toolName: string,
  input: unknown,
  config: PermissionSystemExtensionConfig,
  sessionAllowedDomains: ReadonlySet<string>,
): boolean {
  if (!config.allowWebAccess || toolName !== "fetch_content") {
    return false;
  }
  const domain = extractDomainFromUrl(input);
  if (!domain) {
    return false;
  }
  if (sessionAllowedDomains.has(domain)) {
    return true;
  }
  for (const allowed of config.allowedFetchDomains) {
    if (allowed.toLowerCase() === domain) {
      return true;
    }
  }
  return false;
}
