import { expect, test, vi } from "vitest";
import { registerPermissionSystemCommand } from "#src/config-modal";
import type { CommandConfigStore } from "#src/config-store";
import {
  DEFAULT_EXTENSION_CONFIG,
  normalizePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "#src/extension-config";
import type { Rule, Ruleset } from "#src/rule";

const settingsListCapture = vi.hoisted(() => ({
  items: [] as Array<{ id: string; currentValue: string }>,
  onChange: undefined as ((id: string, value: string) => void) | undefined,
  updates: [] as Array<[string, string]>,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getSettingsListTheme: () => ({}),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class {
    constructor(
      items: Array<{ id: string; currentValue: string }>,
      _height: number,
      _theme: unknown,
      onChange: (id: string, value: string) => void,
    ) {
      settingsListCapture.items = items;
      settingsListCapture.onChange = onChange;
      settingsListCapture.updates = [];
    }
    handleInput(): void {}
    updateValue(id: string, value: string): void {
      settingsListCapture.updates.push([id, value]);
    }
    render(): string[] {
      return [];
    }
    invalidate(): void {}
  },
}));

type Notification = { message: string; level: "info" | "warning" | "error" };

type CommandContextStub = {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    custom<T>(
      renderer: (...args: unknown[]) => unknown,
      options?: unknown,
    ): Promise<T>;
  };
};

type CommandDefinition = {
  description: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => Array<{ value: string; label: string; description?: string }> | null;
  handler: (args: string, ctx: CommandContextStub) => Promise<void>;
};

function createCommandContext(hasUI: boolean): {
  ctx: CommandContextStub;
  notifications: Notification[];
  getCustomCalls(): number;
} {
  const notifications: Notification[] = [];
  let customCalls = 0;

  return {
    ctx: {
      hasUI,
      ui: {
        notify(message: string, level: "info" | "warning" | "error") {
          notifications.push({ message, level });
        },
        async custom<T>(
          renderer: (...args: unknown[]) => unknown,
          _options?: unknown,
        ): Promise<T> {
          customCalls += 1;
          renderer({}, {}, {}, () => undefined);
          return undefined as T;
        },
      },
    },
    notifications,
    getCustomCalls: () => customCalls,
  };
}

function lastNotification(notifications: Notification[]): Notification {
  return notifications[notifications.length - 1];
}

function makeCommandHarness(
  options: {
    config?: PermissionSystemExtensionConfig;
    configPath?: string;
    rules?: Ruleset;
  } = {},
): {
  definition: CommandDefinition;
  registeredName: string;
  save: ReturnType<typeof vi.fn>;
  current(): PermissionSystemExtensionConfig;
} {
  let config = options.config ?? { ...DEFAULT_EXTENSION_CONFIG };
  const save = vi.fn((next: PermissionSystemExtensionConfig) => {
    config = next;
  });
  const configStore: CommandConfigStore = {
    current: () => config,
    save,
  };
  let registeredName = "";
  let definition: CommandDefinition | null = null;

  registerPermissionSystemCommand(
    {
      registerCommand(name: string, nextDefinition: CommandDefinition) {
        registeredName = name;
        definition = nextDefinition;
      },
    } as never,
    {
      config: configStore,
      configPath: options.configPath ?? "/fake/config.json",
      getActiveAgentConfigRules: () => options.rules ?? [],
    },
  );

  return {
    definition: definition!,
    registeredName,
    save,
    current: () => config,
  };
}

test("permission-system command completions expose top-level config actions", () => {
  const { definition } = makeCommandHarness();

  expect(definition.getArgumentCompletions).toBeTypeOf("function");
  const topLevel = definition.getArgumentCompletions?.("");
  expect(topLevel?.some((item) => item.value === "show")).toBe(true);
  expect(topLevel?.some((item) => item.value === "reset")).toBe(true);
  expect(
    definition.getArgumentCompletions?.("pa")?.map((item) => item.value),
  ).toEqual(["path"]);
  expect(definition.getArgumentCompletions?.("path extra")).toBe(null);
  expect(definition.getArgumentCompletions?.("zzz")).toBe(null);
});

test("permission-system registers its command metadata", () => {
  const { definition, registeredName } = makeCommandHarness();

  expect(registeredName).toBe("permission-system");
  expect(definition.description).toContain("Configure pi-permission-system");
});

test("show summarizes active hook settings", async () => {
  const config = {
    ...DEFAULT_EXTENSION_CONFIG,
    debugLog: true,
    yoloMode: true,
    allowLocalEdits: true,
    zellijTabAlert: true,
  };
  const { definition } = makeCommandHarness({ config });
  const context = createCommandContext(true);

  await definition.handler("show", context.ctx);

  const message = lastNotification(context.notifications).message;
  expect(message).toContain("yoloMode=on");
  expect(message).toContain("allowLocalEdits=on");
  expect(message).toContain("zellijTabAlert=on");
  expect(message).toContain("debugLog=on");
});

test.each([
  ["path", "permission-system config: /custom/config.json", "info"],
  ["help", "Usage: /permission-system", "info"],
  ["unknown", "Usage: /permission-system", "warning"],
] as const)("%s reports the expected command response", async (argument, text, level) => {
  const { definition } = makeCommandHarness({
    configPath: "/custom/config.json",
  });
  const context = createCommandContext(true);

  await definition.handler(argument, context.ctx);

  expect(lastNotification(context.notifications)).toEqual(
    expect.objectContaining({ level }),
  );
  expect(lastNotification(context.notifications).message).toContain(text);
});

test("reset restores settings while preserving the active hook set", async () => {
  const config = normalizePermissionSystemConfig({
    debugLog: true,
    permissionReviewLog: false,
    yoloMode: true,
    allowLocalEdits: true,
    doublePressToConfirm: false,
    zellijTabAlert: true,
    hooks: {
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [{ type: "command", command: "policy-check" }],
        },
      ],
    },
  });
  const { definition, save, current } = makeCommandHarness({ config });
  const context = createCommandContext(true);

  await definition.handler("reset", context.ctx);

  expect(save).toHaveBeenCalledOnce();
  expect(current()).toEqual({
    ...DEFAULT_EXTENSION_CONFIG,
    hooks: config.hooks,
  });
  expect(lastNotification(context.notifications).message).toBe(
    "Permission system settings reset to defaults.",
  );
});

test("an empty command warns when no interactive UI exists", async () => {
  const { definition } = makeCommandHarness();
  const context = createCommandContext(false);

  await definition.handler("", context.ctx);

  expect(lastNotification(context.notifications).message).toBe(
    "/permission-system requires interactive TUI mode.",
  );
  expect(context.getCustomCalls()).toBe(0);
});

test("an empty command opens the settings modal in a UI session", async () => {
  const { definition } = makeCommandHarness();
  const context = createCommandContext(true);

  await definition.handler("", context.ctx);

  expect(context.getCustomCalls()).toBe(1);
  expect(settingsListCapture.items).toContainEqual(
    expect.objectContaining({
      id: "zellijTabAlert",
      currentValue: "off",
    }),
  );
});

test("the settings modal toggles the Zellij alert", async () => {
  const { definition, save, current } = makeCommandHarness();
  const context = createCommandContext(true);

  await definition.handler("", context.ctx);
  settingsListCapture.onChange?.("zellijTabAlert", "on");

  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ zellijTabAlert: true }),
    context.ctx,
  );
  expect(current().zellijTabAlert).toBe(true);
  expect(settingsListCapture.updates).toContainEqual(["zellijTabAlert", "on"]);
});

test("show output includes rule origins when composed rules exist", async () => {
  const composedRules: Rule[] = [
    {
      surface: "read",
      pattern: "*",
      action: "allow",
      layer: "config",
      origin: "global",
    },
    {
      surface: "bash",
      pattern: "rm *",
      action: "deny",
      layer: "config",
      origin: "project",
    },
  ];
  const { definition } = makeCommandHarness({ rules: composedRules });
  const context = createCommandContext(true);

  await definition.handler("show", context.ctx);
  const message = lastNotification(context.notifications).message;

  expect(message).toContain("global");
  expect(message).toContain("project");
  expect(message).toContain("read");
  expect(message).toContain("bash");
});

test("show output omits a rule summary when no composed rules exist", async () => {
  const config = { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true };
  const { definition } = makeCommandHarness({ config });
  const context = createCommandContext(true);

  await definition.handler("show", context.ctx);
  const message = lastNotification(context.notifications).message;

  expect(message).toContain("yoloMode=on");
  expect(message).not.toContain("(global)");
});
