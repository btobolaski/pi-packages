import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugReviewLogger } from "./session-logger";
import { toRecord } from "./value-guards";

const ALERT_PREFIX = "🔔 ";
const ALERT_BACKGROUND = "#5f0000";
const COMMAND_TIMEOUT_MS = 2000;
const LIST_PANES_ARGS = ["action", "list-panes", "--json", "--all"];

/** Process and command seams injected by the extension composition root. */
export interface ZellijTabAlertDeps {
  exec: ExtensionAPI["exec"];
  isEnabled: () => boolean;
  zellijPaneId: string | undefined;
  logger: DebugReviewLogger;
}

interface ZellijPane {
  id: number;
  isPlugin: boolean;
  tabId: number;
  tabName: string;
}

interface ActiveAlert {
  paneId: number;
  tabId: number;
  originalTabName: string;
  alertTabName: string;
}

/**
 * Owns the serving UI session's single cosmetic Zellij alert.
 * All expected command and discovery failures resolve after debug logging.
 */
export class ZellijTabAlert {
  private active: ActiveAlert | undefined;

  constructor(private readonly deps: ZellijTabAlertDeps) {}

  /** Mark the discovered serving tab and Pi pane unless already active. */
  async activate(): Promise<void> {
    if (!this.deps.isEnabled() || !this.deps.zellijPaneId || this.active) {
      return;
    }

    const paneId = Number(this.deps.zellijPaneId);
    if (!Number.isFinite(paneId)) {
      this.logDiscoveryFailure("invalid_pane_id");
      return;
    }

    const panes = await this.listPanes();
    const pane = panes
      ?.map(toZellijPane)
      .find((item) => item?.isPlugin === false && item.id === paneId);
    if (!pane) {
      this.logDiscoveryFailure("pane_not_found");
      return;
    }

    const alertTabName = pane.tabName.startsWith(ALERT_PREFIX)
      ? pane.tabName
      : `${ALERT_PREFIX}${pane.tabName}`;
    this.active = {
      paneId: pane.id,
      tabId: pane.tabId,
      originalTabName: pane.tabName,
      alertTabName,
    };

    if (alertTabName !== pane.tabName) {
      await this.run([
        "action",
        "rename-tab",
        "--tab-id",
        String(pane.tabId),
        alertTabName,
      ]);
    }
    await this.run([
      "action",
      "set-pane-color",
      "--pane-id",
      String(pane.id),
      "--bg",
      ALERT_BACKGROUND,
    ]);
  }

  /** Discard local state, then safely restore the tab name and reset the pane. */
  async clear(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;

    const panes = await this.listPanes();
    const currentTab = panes
      ?.map(toZellijPane)
      .find((pane) => pane?.tabId === active.tabId);
    if (
      currentTab?.tabName === active.alertTabName &&
      active.alertTabName !== active.originalTabName
    ) {
      await this.run([
        "action",
        "rename-tab",
        "--tab-id",
        String(active.tabId),
        active.originalTabName,
      ]);
    }

    await this.run([
      "action",
      "set-pane-color",
      "--pane-id",
      String(active.paneId),
      "--reset",
    ]);
  }

  private async listPanes(): Promise<unknown[] | undefined> {
    const result = await this.run(LIST_PANES_ARGS);
    if (!result) return undefined;

    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (Array.isArray(parsed)) return parsed as unknown[];
      this.logDiscoveryFailure("response_not_array");
    } catch (error) {
      this.logDiscoveryFailure("invalid_json", error);
    }
    return undefined;
  }

  private async run(args: string[]): Promise<ExecResult | undefined> {
    try {
      const result = await this.deps.exec("zellij", args, {
        timeout: COMMAND_TIMEOUT_MS,
      });
      if (result.code !== 0 || result.killed) {
        this.deps.logger.debug("zellij_tab_alert.command_failed", {
          args,
          code: result.code,
          killed: result.killed,
          stderr: result.stderr,
        });
        return undefined;
      }
      return result;
    } catch (error) {
      this.deps.logger.debug("zellij_tab_alert.command_failed", {
        args,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return undefined;
    }
  }

  private logDiscoveryFailure(reason: string, error?: unknown): void {
    this.deps.logger.debug("zellij_tab_alert.discovery_failed", {
      reason,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : "Unknown error" }),
    });
  }
}

function toZellijPane(value: unknown): ZellijPane | undefined {
  const pane = toRecord(value);
  if (
    typeof pane.id !== "number" ||
    !Number.isFinite(pane.id) ||
    typeof pane.is_plugin !== "boolean" ||
    typeof pane.tab_id !== "number" ||
    !Number.isFinite(pane.tab_id) ||
    typeof pane.tab_name !== "string"
  ) {
    return undefined;
  }
  return {
    id: pane.id,
    isPlugin: pane.is_plugin,
    tabId: pane.tab_id,
    tabName: pane.tab_name,
  };
}
