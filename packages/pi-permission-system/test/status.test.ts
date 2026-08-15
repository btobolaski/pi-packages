import { expect, test } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { getPermissionSystemStatus } from "#src/status";

test("Permission-system status identifies the hook bypass mode", () => {
  expect(getPermissionSystemStatus(DEFAULT_EXTENSION_CONFIG)).toBe(undefined);
  expect(
    getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
  ).toBe("hook:bypassPermissions");
});
