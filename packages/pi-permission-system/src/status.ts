import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  EXTENSION_ID,
  isYoloModeEnabled,
  type PermissionSystemExtensionConfig,
} from "./extension-config";

export const PERMISSION_SYSTEM_STATUS_KEY = EXTENSION_ID;
export const PERMISSION_SYSTEM_HOOK_BYPASS_STATUS_VALUE =
  "hook:bypassPermissions";

type PermissionStatusContext =
  | Pick<ExtensionContext, "hasUI" | "ui">
  | Pick<ExtensionCommandContext, "ui">;

export function getPermissionSystemStatus(
  config: PermissionSystemExtensionConfig,
): string | undefined {
  return isYoloModeEnabled(config)
    ? PERMISSION_SYSTEM_HOOK_BYPASS_STATUS_VALUE
    : undefined;
}

export function syncPermissionSystemStatus(
  ctx: PermissionStatusContext,
  config: PermissionSystemExtensionConfig,
): void {
  ctx.ui.setStatus(
    PERMISSION_SYSTEM_STATUS_KEY,
    getPermissionSystemStatus(config),
  );
}
