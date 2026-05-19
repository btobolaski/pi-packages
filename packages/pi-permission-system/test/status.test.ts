import { expect, test } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { getPermissionSystemStatus } from "#src/status";

test("permission-system status reports enabled runtime overrides", () => {
  expect(getPermissionSystemStatus(DEFAULT_EXTENSION_CONFIG)).toBe(undefined);
  expect(
    getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
  ).toBe("yolo");
  expect(
    getPermissionSystemStatus({
      ...DEFAULT_EXTENSION_CONFIG,
      allowLocalEdits: true,
    }),
  ).toBe("local-edits");
  expect(
    getPermissionSystemStatus({
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
      allowLocalEdits: true,
      allowWebAccess: true,
    }),
  ).toBe("yolo+local-edits+web-access");
});
