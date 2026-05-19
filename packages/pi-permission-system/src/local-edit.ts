import { homedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";

import { toRecord } from "./common";
import type { PermissionSystemExtensionConfig } from "./extension-config";

/**
 * Normalize a path string into an absolute, comparable form.
 *
 * Strips surrounding quotes and a leading `@` (Pi's "attach file" prefix),
 * expands a leading `~`/`~\` to the user's home directory, resolves the
 * result against `cwd`, and finally lowercases on Windows so directory
 * comparisons are case-insensitive on case-insensitive file systems.
 *
 * Returns an empty string when the input has no usable content.
 */
export function normalizePathForComparison(
  pathValue: string,
  cwd: string,
): string {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return "";
  }

  let normalizedPath = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

  if (normalizedPath === "~") {
    normalizedPath = homedir();
  } else if (
    normalizedPath.startsWith("~/") ||
    normalizedPath.startsWith("~\\")
  ) {
    normalizedPath = join(homedir(), normalizedPath.slice(2));
  }

  const absolutePath = resolve(cwd, normalizedPath);
  const normalizedAbsolutePath = normalize(absolutePath);
  return process.platform === "win32"
    ? normalizedAbsolutePath.toLowerCase()
    : normalizedAbsolutePath;
}

/**
 * Return true when `pathValue` is `directory` itself or sits inside it.
 *
 * Uses path-separator-aware prefix matching so that
 * `/project-foo` does NOT match `/project`.
 */
export function isPathWithinDirectory(
  pathValue: string,
  directory: string,
): boolean {
  if (!pathValue || !directory) {
    return false;
  }

  if (pathValue === directory) {
    return true;
  }

  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return pathValue.startsWith(prefix);
}

/**
 * Extract a normalized absolute file path from tool input.
 *
 * Accepts both `file_path` (Claude Code shape) and `path` (Pi shape).
 * Returns null when neither field is present or both are empty.
 */
export function extractNormalizedFilePath(
  input: unknown,
  cwd: string,
): string | null {
  const record = toRecord(input);
  const filePath = record.file_path ?? record.path;
  if (typeof filePath !== "string" || !filePath.trim()) {
    return null;
  }
  return normalizePathForComparison(filePath, cwd);
}

/**
 * Decide whether the `allowLocalEdits` override should auto-approve a tool call.
 *
 * Returns true only when:
 *   - `config.allowLocalEdits` is enabled
 *   - the tool is `edit` or `write`
 *   - the targeted file is inside `cwd`
 */
export function shouldAllowLocalEdit(
  toolName: string,
  input: unknown,
  cwd: string,
  config: PermissionSystemExtensionConfig,
): boolean {
  if (!config.allowLocalEdits) {
    return false;
  }
  if (toolName !== "edit" && toolName !== "write") {
    return false;
  }
  const normalizedPath = extractNormalizedFilePath(input, cwd);
  if (!normalizedPath) {
    return false;
  }
  const normalizedCwd = normalizePathForComparison(cwd, cwd);
  return isPathWithinDirectory(normalizedPath, normalizedCwd);
}
