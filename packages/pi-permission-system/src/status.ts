import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  EXTENSION_ID,
  type PermissionSystemExtensionConfig,
} from "./extension-config";
import { isYoloModeEnabled } from "./yolo-mode";

export const PERMISSION_SYSTEM_STATUS_KEY = EXTENSION_ID;
export const PERMISSION_SYSTEM_YOLO_STATUS_VALUE = "yolo";
export const PERMISSION_SYSTEM_LOCAL_EDITS_STATUS_VALUE = "local-edits";
export const PERMISSION_SYSTEM_WEB_ACCESS_STATUS_VALUE = "web-access";

type PermissionStatusContext =
  | Pick<ExtensionContext, "hasUI" | "ui">
  | Pick<ExtensionCommandContext, "ui">;

export function getPermissionSystemStatus(
  config: PermissionSystemExtensionConfig,
): string | undefined {
  const parts: string[] = [];
  if (isYoloModeEnabled(config)) {
    parts.push(PERMISSION_SYSTEM_YOLO_STATUS_VALUE);
  }
  if (config.allowLocalEdits) {
    parts.push(PERMISSION_SYSTEM_LOCAL_EDITS_STATUS_VALUE);
  }
  if (config.allowWebAccess) {
    parts.push(PERMISSION_SYSTEM_WEB_ACCESS_STATUS_VALUE);
  }
  return parts.length > 0 ? parts.join("+") : undefined;
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
