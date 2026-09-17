import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessIntent } from "#src/access-intent/access-intent";
import { AuthorizerRegistry } from "#src/authority/authorizer-registry";
import { PermissionDelegation } from "#src/authority/permission-delegation";
import { posixPathFlavor } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path-normalizer";
import { LocalPermissionsService } from "#src/permissions-service";
import type { PermissionsService } from "#src/service";
import {
  getPermissionsService,
  publishPermissionsService,
  unpublishPermissionsService,
} from "#src/service";
import { PermissionServiceLifecycle } from "#src/service-lifecycle";
import { ToolAccessExtractorRegistry } from "#src/tool-access-extractor-registry";
import { ToolInputFormatterRegistry } from "#src/tool-input-formatter-registry";
import type { PermissionCheckResult, PermissionState } from "#src/types";
import { makeCtx } from "#test/helpers/handler-fixtures";

// ── helpers ────────────────────────────────────────────────────────────────

function makeService(
  overrides: Partial<PermissionsService> = {},
): PermissionsService {
  return {
    checkPermission: vi.fn(),
    getToolPermission: vi.fn(),
    registerToolInputFormatter: vi.fn(),
    registerToolAccessExtractor: vi.fn(),
    registerAuthorizer: vi.fn(),
    connectDelegation: vi.fn(),
    subscribeDelegatedWaits: vi.fn().mockReturnValue(() => {}),
    getDelegationState: vi.fn().mockReturnValue({ status: "not-required" }),
    ...overrides,
  };
}

// ── globalThis accessor ────────────────────────────────────────────────────

describe("globalThis accessor", () => {
  const created = new Set<PermissionsService>();
  function trackedService() {
    const service = { ...makeService(), closeDelegation: vi.fn() };
    created.add(service);
    return service;
  }

  afterEach(() => {
    const current = getPermissionsService();
    if (current) unpublishPermissionsService(current);
    for (const service of created) unpublishPermissionsService(service);
    created.clear();
  });

  it("returns undefined when nothing has been published", () => {
    expect(getPermissionsService()).toBeUndefined();
  });

  it("returns the published service", () => {
    const service = makeService();
    publishPermissionsService(service);
    expect(getPermissionsService()).toBe(service);
  });

  it("overwrites a previously published service", () => {
    const first = makeService();
    const second = makeService();
    publishPermissionsService(first);
    publishPermissionsService(second);
    expect(getPermissionsService()).toBe(second);
  });

  it("removes the slot when it still holds the given service", () => {
    const service = makeService();
    publishPermissionsService(service);
    unpublishPermissionsService(service);
    expect(getPermissionsService()).toBeUndefined();
  });

  it("does not remove the slot when a different service occupies it", () => {
    const parent = makeService();
    const child = makeService();
    publishPermissionsService(parent);
    // A child instance never published `parent`; unpublishing its own service
    // must be a no-op that leaves the parent's slot intact.
    unpublishPermissionsService(child);
    expect(getPermissionsService()).toBe(parent);
  });

  it("unpublish is safe to call when nothing was published", () => {
    expect(() => unpublishPermissionsService(makeService())).not.toThrow();
    expect(getPermissionsService()).toBeUndefined();
  });

  it("keeps child services exact-session-only without replacing the parent default", () => {
    const parent = makeService();
    const child = makeService();
    publishPermissionsService(parent, "parent");
    publishPermissionsService(child, "child", { asDefault: false });

    expect(getPermissionsService()).toBe(parent);
    expect(getPermissionsService("parent")).toBe(parent);
    expect(getPermissionsService("child")).toBe(child);

    unpublishPermissionsService(child);
    expect(getPermissionsService()).toBe(parent);
    expect(getPermissionsService("child")).toBeUndefined();
  });

  it.each([
    "legacy first",
    "literal first",
  ])("keeps legacy and literal default independent when publishing %s", (order) => {
    const parent = trackedService();
    const child = trackedService();
    if (order === "legacy first") publishPermissionsService(parent);
    publishPermissionsService(child, "__default__", { asDefault: false });
    if (order === "literal first") publishPermissionsService(parent);
    expect(getPermissionsService()).toBe(parent);
    expect(getPermissionsService("__default__")).toBe(child);
    expect(parent.closeDelegation).not.toHaveBeenCalled();
    expect(child.closeDelegation).not.toHaveBeenCalled();
  });

  it.each([
    "literal session",
    "legacy default",
  ])("removes only the %s without promoting another default", (removed) => {
    const parent = trackedService();
    const child = trackedService();
    publishPermissionsService(parent);
    publishPermissionsService(child, "__default__", { asDefault: false });
    unpublishPermissionsService(removed === "literal session" ? child : parent);
    expect(getPermissionsService()).toBe(
      removed === "literal session" ? parent : undefined,
    );
    expect(getPermissionsService("__default__")).toBe(
      removed === "legacy default" ? child : undefined,
    );
  });

  it("resolves an explicitly published empty session ID without selecting a default", () => {
    const service = trackedService();
    publishPermissionsService(service, "", { asDefault: false });
    expect(getPermissionsService("")).toBe(service);
    expect(getPermissionsService()).toBeUndefined();
  });

  it("replaces the legacy default across fresh module copies without touching the literal session", async () => {
    const oldParent = trackedService();
    const replacement = trackedService();
    const child = trackedService();
    publishPermissionsService(oldParent);
    publishPermissionsService(child, "__default__", { asDefault: false });
    vi.resetModules();
    const fresh = await import("#src/service");
    fresh.publishPermissionsService(replacement);
    expect(oldParent.closeDelegation).toHaveBeenCalledOnce();
    expect(child.closeDelegation).not.toHaveBeenCalled();
    expect(getPermissionsService()).toBe(replacement);
    expect(fresh.getPermissionsService()).toBe(replacement);
    expect(getPermissionsService("__default__")).toBe(child);
    expect(fresh.getPermissionsService("__default__")).toBe(child);
    unpublishPermissionsService(oldParent);
    expect(fresh.getPermissionsService()).toBe(replacement);
  });

  it("selects a named default without retiring the legacy service", () => {
    const legacy = trackedService();
    const named = trackedService();
    publishPermissionsService(legacy);
    publishPermissionsService(named, "__default__");
    expect(getPermissionsService()).toBe(named);
    expect(getPermissionsService("__default__")).toBe(named);
    expect(legacy.closeDelegation).not.toHaveBeenCalled();
    unpublishPermissionsService(named);
    expect(getPermissionsService()).toBeUndefined();
    expect(getPermissionsService("__default__")).toBeUndefined();
  });

  it("does not retire a service republished at the same key", () => {
    const legacy = trackedService();
    const named = trackedService();
    publishPermissionsService(legacy);
    publishPermissionsService(named, "__default__");
    publishPermissionsService(named, "__default__");
    expect(getPermissionsService()).toBe(named);
    expect(named.closeDelegation).not.toHaveBeenCalled();
    expect(legacy.closeDelegation).not.toHaveBeenCalled();
  });

  it("removes every key owned by the same service", () => {
    const shared = trackedService();
    publishPermissionsService(shared);
    publishPermissionsService(shared, "__default__", { asDefault: false });
    unpublishPermissionsService(shared);
    expect(getPermissionsService()).toBeUndefined();
    expect(getPermissionsService("__default__")).toBeUndefined();
  });

  it("retires a prepared predecessor once before replacement publication", () => {
    const oldService = { ...makeService(), closeDelegation: vi.fn() };
    const replacement = makeService();
    const ctx = makeCtx();
    publishPermissionsService(oldService, "session-test");
    const lifecycle = new PermissionServiceLifecycle(
      replacement,
      { isRegisteredChild: () => false },
      { emit: vi.fn(), on: vi.fn() },
      [],
    );
    lifecycle.prepare(ctx);
    expect(oldService.closeDelegation).toHaveBeenCalledOnce();
    expect(getPermissionsService("session-test")).toBeUndefined();
    lifecycle.activate(ctx);
    expect(oldService.closeDelegation).toHaveBeenCalledOnce();
    expect(getPermissionsService("session-test")).toBe(replacement);
  });

  it("does not let a replaced instance remove its successor", () => {
    const oldService = makeService();
    const replacement = makeService();
    publishPermissionsService(oldService, "parent");
    publishPermissionsService(replacement, "parent");

    unpublishPermissionsService(oldService);
    expect(getPermissionsService()).toBe(replacement);
    expect(getPermissionsService("parent")).toBe(replacement);
  });

  it("shares exact-session services across fresh module copies", async () => {
    const service = makeService();
    publishPermissionsService(service, "parent");

    vi.resetModules();
    const freshServiceModule = await import("#src/service");
    expect(freshServiceModule.getPermissionsService("parent")).toBe(service);
    freshServiceModule.unpublishPermissionsService(service);
  });
});

// ── service adapter delegation ─────────────────────────────────────────────

describe("service round-trip through the global slot", () => {
  afterEach(() => {
    const current = getPermissionsService();
    if (current) {
      unpublishPermissionsService(current);
    }
  });

  const fakeResult: PermissionCheckResult = {
    toolName: "bash",
    state: "allow",
    matchedPattern: "git *",
    source: "bash",
    origin: "global",
  };

  function makeResolver() {
    return {
      resolve: vi
        .fn<(intent: AccessIntent) => PermissionCheckResult>()
        .mockReturnValue(fakeResult),
      getToolPermission: vi
        .fn<(toolName: string, agentName?: string) => PermissionState>()
        .mockReturnValue("ask"),
    };
  }

  function publishLocalService(resolver: ReturnType<typeof makeResolver>) {
    publishPermissionsService(
      new LocalPermissionsService(
        resolver,
        {
          getPathNormalizer: () =>
            new PathNormalizer(posixPathFlavor, "/test/project"),
          deactivate: vi.fn(),
        },
        new ToolInputFormatterRegistry(),
        new ToolAccessExtractorRegistry(),
        new AuthorizerRegistry(),
        new PermissionDelegation(
          { getContext: () => null, canonicalizeCwd: (value) => value },
          {
            connect: vi.fn(),
            discardBinding: vi.fn(),
            isBindingLive: () => true,
            getBindingSignal: () => undefined,
            close: vi.fn(),
          },
          false,
        ),
      ),
    );
  }

  it("resolves a non-path query via a tool intent", () => {
    const resolver = makeResolver();
    publishLocalService(resolver);
    const result = getPermissionsService()!.checkPermission(
      "bash",
      "git push",
      "Explore",
    );
    expect(result).toBe(fakeResult);
    expect(resolver.resolve).toHaveBeenCalledWith({
      kind: "tool",
      surface: "bash",
      input: { command: "git push" },
      agentName: "Explore",
    });
  });

  it("resolves a path-surface query via an access-path intent", () => {
    const resolver = makeResolver();
    publishLocalService(resolver);
    getPermissionsService()!.checkPermission("read", "/test/project/.env");
    const intent = resolver.resolve.mock.calls[0][0];
    expect(intent.kind).toBe("access-path");
    if (intent.kind === "access-path") {
      expect(intent.surface).toBe("read");
    }
  });

  it("delegates getToolPermission through the resolver", () => {
    const resolver = makeResolver();
    resolver.getToolPermission.mockReturnValue("deny");
    publishLocalService(resolver);
    const result = getPermissionsService()!.getToolPermission(
      "write",
      "Explore",
    );
    expect(result).toBe("deny");
    expect(resolver.getToolPermission).toHaveBeenCalledWith("write", "Explore");
  });
});

// ── registerToolInputFormatter delegation ─────────────────────────────────

describe("registerToolInputFormatter delegation", () => {
  afterEach(() => {
    const current = getPermissionsService();
    if (current) {
      unpublishPermissionsService(current);
    }
  });

  it("delegates to the registry and returns its disposer", () => {
    const registry = new ToolInputFormatterRegistry();
    const formatter = () => "preview";

    const service = makeService({
      registerToolInputFormatter(toolName, fmt) {
        return registry.register(toolName, fmt);
      },
    });

    publishPermissionsService(service);
    const dispose = getPermissionsService()!.registerToolInputFormatter(
      "my-tool",
      formatter,
    );

    // Registry received the registration
    expect(registry.get("my-tool")).toBe(formatter);

    // Disposer returned from service removes it from the registry
    dispose();
    expect(registry.get("my-tool")).toBeUndefined();
  });

  it("throws when a formatter is already registered for the tool name", () => {
    const registry = new ToolInputFormatterRegistry();
    registry.register("my-tool", () => undefined);

    const service = makeService({
      registerToolInputFormatter(toolName, fmt) {
        return registry.register(toolName, fmt);
      },
    });

    publishPermissionsService(service);
    expect(() =>
      getPermissionsService()!.registerToolInputFormatter("my-tool", () => ""),
    ).toThrow("my-tool");
  });
});

// ── registerToolAccessExtractor delegation (#352) ────────────────────────

describe("registerToolAccessExtractor delegation", () => {
  afterEach(() => {
    const current = getPermissionsService();
    if (current) {
      unpublishPermissionsService(current);
    }
  });

  it("delegates to the registry and returns its disposer", () => {
    const registry = new ToolAccessExtractorRegistry();
    const extractor = () => "/etc/hosts";

    const service = makeService({
      registerToolAccessExtractor(toolName, ext) {
        return registry.register(toolName, ext);
      },
    });

    publishPermissionsService(service);
    const dispose = getPermissionsService()!.registerToolAccessExtractor(
      "ffgrep",
      extractor,
    );

    expect(registry.get("ffgrep")).toBe(extractor);

    dispose();
    expect(registry.get("ffgrep")).toBeUndefined();
  });

  it("throws when an extractor is already registered for the tool name", () => {
    const registry = new ToolAccessExtractorRegistry();
    registry.register("ffgrep", () => undefined);

    const service = makeService({
      registerToolAccessExtractor(toolName, ext) {
        return registry.register(toolName, ext);
      },
    });

    publishPermissionsService(service);
    expect(() =>
      getPermissionsService()!.registerToolAccessExtractor("ffgrep", () => ""),
    ).toThrow("ffgrep");
  });
});
