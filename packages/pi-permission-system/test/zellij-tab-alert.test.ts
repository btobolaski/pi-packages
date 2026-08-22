import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { DebugReviewLogger } from "#src/session-logger";
import { ZellijTabAlert } from "#src/zellij-tab-alert";

const LIST_ARGS = ["action", "list-panes", "--json", "--all"];
const ALERT_RENAME_ARGS = ["action", "rename-tab", "--tab-id", "12", "🔔 work"];
const RESTORE_RENAME_ARGS = ["action", "rename-tab", "--tab-id", "12", "work"];
const COLOR_ARGS = [
  "action",
  "set-pane-color",
  "--pane-id",
  "7",
  "--bg",
  "#5f0000",
];
const RESET_ARGS = ["action", "set-pane-color", "--pane-id", "7", "--reset"];
const EXEC_OPTIONS = { timeout: 2000 };

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type ExecOutcome = ExecResult | Error;

function result(stdout = "", overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false, ...overrides };
}

function panes(tabName = "work") {
  return [
    { id: 7, is_plugin: true, tab_id: 99, tab_name: "plugin" },
    { id: 7, is_plugin: false, tab_id: 12, tab_name: tabName },
  ];
}

function listResult(tabName = "work"): ExecResult {
  return result(JSON.stringify(panes(tabName)));
}

function scriptExec(...outcomes: ExecOutcome[]) {
  const exec = vi.fn<ExtensionAPI["exec"]>();
  for (const outcome of outcomes) {
    if (outcome instanceof Error) exec.mockRejectedValueOnce(outcome);
    else exec.mockResolvedValueOnce(outcome);
  }
  return exec;
}

function happyPathScript(): ExecOutcome[] {
  return [
    listResult(),
    result(),
    result(),
    listResult("🔔 work"),
    result(),
    result(),
  ];
}

function makeAlert(
  overrides: {
    exec?: ExtensionAPI["exec"];
    isEnabled?: () => boolean;
    zellijPaneId?: string;
  } = {},
) {
  const exec = overrides.exec ?? scriptExec();
  const logger: DebugReviewLogger = { debug: vi.fn(), review: vi.fn() };
  return {
    alert: new ZellijTabAlert({
      exec,
      isEnabled: overrides.isEnabled ?? (() => true),
      zellijPaneId: "zellijPaneId" in overrides ? overrides.zellijPaneId : "7",
      logger,
    }),
    exec,
    logger,
  };
}

describe("ZellijTabAlert", () => {
  it("does nothing when disabled", async () => {
    const { alert, exec } = makeAlert({ isEnabled: () => false });
    await expect(alert.activate()).resolves.toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("does nothing outside Zellij", async () => {
    const { alert, exec } = makeAlert({ zellijPaneId: undefined });
    await expect(alert.activate()).resolves.toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails open for a non-numeric Zellij pane ID", async () => {
    const { alert, exec, logger } = makeAlert({ zellijPaneId: "abc" });
    await expect(alert.activate()).resolves.toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "zellij_tab_alert.discovery_failed",
      { reason: "invalid_pane_id" },
    );
  });

  it("reads the enabled setting for each activation", async () => {
    let enabled = false;
    const exec = scriptExec(listResult(), result(), result());
    const { alert } = makeAlert({ exec, isEnabled: () => enabled });
    await alert.activate();
    enabled = true;
    await alert.activate();
    expect(exec).toHaveBeenCalledWith("zellij", LIST_ARGS, EXEC_OPTIONS);
  });

  it("selects the terminal pane and targets its stable tab and pane IDs", async () => {
    const exec = scriptExec(...happyPathScript());
    const { alert } = makeAlert({ exec });
    await alert.activate();
    await alert.clear();
    expect(exec.mock.calls).toEqual([
      ["zellij", LIST_ARGS, EXEC_OPTIONS],
      ["zellij", ALERT_RENAME_ARGS, EXEC_OPTIONS],
      ["zellij", COLOR_ARGS, EXEC_OPTIONS],
      ["zellij", LIST_ARGS, EXEC_OPTIONS],
      ["zellij", RESTORE_RENAME_ARGS, EXEC_OPTIONS],
      ["zellij", RESET_ARGS, EXEC_OPTIONS],
    ]);
  });

  it("does not duplicate or later strip an original alert prefix", async () => {
    const exec = scriptExec(
      listResult("🔔 custom"),
      result(),
      listResult("🔔 custom"),
      result(),
    );
    const { alert } = makeAlert({ exec });
    await alert.activate();
    await alert.activate();
    await alert.clear();
    expect(exec).toHaveBeenCalledTimes(4);
    expect(
      exec.mock.calls.some(([, args]) => args.includes("rename-tab")),
    ).toBe(false);
    expect(exec).toHaveBeenCalledWith("zellij", COLOR_ARGS, EXEC_OPTIONS);
  });

  it("makes repeated clear calls no-ops", async () => {
    const exec = scriptExec(...happyPathScript());
    const { alert } = makeAlert({ exec });
    await alert.activate();
    await alert.clear();
    await alert.clear();
    expect(exec).toHaveBeenCalledTimes(6);
  });

  it("preserves a user-renamed tab while resetting the pane", async () => {
    const exec = scriptExec(
      listResult(),
      result(),
      result(),
      listResult("renamed by user"),
      result(),
    );
    const { alert } = makeAlert({ exec });
    await alert.activate();
    await alert.clear();
    expect(exec).toHaveBeenCalledTimes(5);
    expect(exec).not.toHaveBeenCalledWith(
      "zellij",
      RESTORE_RENAME_ARGS,
      EXEC_OPTIONS,
    );
    expect(exec).toHaveBeenLastCalledWith("zellij", RESET_ARGS, EXEC_OPTIONS);
  });

  it.each([
    ["a thrown list command", new Error("missing zellij")],
    ["a non-zero list command", result("", { code: 1 })],
    ["a killed list command", result("", { killed: true })],
    ["invalid list JSON", result("not json")],
    ["a non-array list response", result("{}")],
    [
      "a missing terminal pane",
      result(JSON.stringify([{ ...panes()[0], is_plugin: true }])),
    ],
    [
      "malformed terminal tab fields",
      result(JSON.stringify([{ id: 7, is_plugin: false, tab_name: "work" }])),
    ],
    [
      "a terminal pane without a numeric id",
      result(
        JSON.stringify([{ is_plugin: false, tab_id: 12, tab_name: "work" }]),
      ),
    ],
  ])("fails open for %s", async (_name, outcome) => {
    const exec = scriptExec(outcome);
    const { alert, logger } = makeAlert({ exec });
    await expect(alert.activate()).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalled();
  });

  it("colors the pane after a rename failure and can still clear it", async () => {
    const exec = scriptExec(
      listResult(),
      new Error("rename failed"),
      result(),
      listResult(),
      result(),
    );
    const { alert } = makeAlert({ exec });
    await expect(alert.activate()).resolves.toBeUndefined();
    await expect(alert.clear()).resolves.toBeUndefined();
    expect(exec).toHaveBeenNthCalledWith(3, "zellij", COLOR_ARGS, EXEC_OPTIONS);
    expect(exec).toHaveBeenLastCalledWith("zellij", RESET_ARGS, EXEC_OPTIONS);
  });

  it("restores and resets after a color failure", async () => {
    const exec = scriptExec(
      listResult(),
      result(),
      result("", { code: 1 }),
      listResult("🔔 work"),
      result(),
      result(),
    );
    const { alert } = makeAlert({ exec });
    await expect(alert.activate()).resolves.toBeUndefined();
    await expect(alert.clear()).resolves.toBeUndefined();
    expect(exec).toHaveBeenNthCalledWith(
      5,
      "zellij",
      RESTORE_RENAME_ARGS,
      EXEC_OPTIONS,
    );
    expect(exec).toHaveBeenLastCalledWith("zellij", RESET_ARGS, EXEC_OPTIONS);
  });

  it("resets the pane when discovery fails during clear", async () => {
    const exec = scriptExec(
      listResult(),
      result(),
      result(),
      new Error("list failed"),
      result(),
    );
    const { alert } = makeAlert({ exec });
    await alert.activate();
    await expect(alert.clear()).resolves.toBeUndefined();
    expect(exec).toHaveBeenLastCalledWith("zellij", RESET_ARGS, EXEC_OPTIONS);
  });

  it("resolves when pane reset fails and discards active state", async () => {
    const script = happyPathScript();
    script[5] = new Error("reset failed");
    const exec = scriptExec(...script);
    const { alert } = makeAlert({ exec });
    await alert.activate();
    await expect(alert.clear()).resolves.toBeUndefined();
    await alert.clear();
    expect(exec).toHaveBeenCalledTimes(6);
  });
});
