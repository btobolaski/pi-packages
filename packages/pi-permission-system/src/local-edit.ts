import type { PermissionSystemExtensionConfig } from "./extension-config";
import type { PathNormalizer } from "./path-normalizer";
import { getPathBearingToolPath } from "./tool-input-path";

/**
 * Decide whether the `allowLocalEdits` override should auto-approve a tool call.
 *
 * The path is interpreted by the session's platform-aware normalizer, including
 * symlink canonicalization. A symlink inside the working directory that points
 * outside it therefore does not receive the override.
 */
export function shouldAllowLocalEdit(
  toolName: string,
  input: unknown,
  normalizer: PathNormalizer,
  config: PermissionSystemExtensionConfig,
): boolean {
  if (!config.allowLocalEdits) {
    return false;
  }
  if (toolName !== "edit" && toolName !== "write") {
    return false;
  }

  const filePath = getPathBearingToolPath(toolName, input);
  if (filePath === null) {
    return false;
  }

  const accessPath = normalizer.forPath(filePath);
  return !normalizer.isBoundaryOutsideWorkingDirectory(
    accessPath.boundaryValue(),
  );
}
