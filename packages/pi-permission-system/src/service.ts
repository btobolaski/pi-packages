/**
 * Cross-extension service accessor backed by `Symbol.for()` on `globalThis`.
 *
 * `Symbol.for()` is process-global by spec, so it survives jiti's per-extension
 * module isolation (`moduleCache: false`). A consumer doing
 * `import("@gotgenes/pi-permission-system")` gets a fresh module copy, but
 * `getPermissionsService(sessionId)` reads from the same `globalThis` map the
 * provider wrote to — enabling direct, synchronous, type-safe function calls.
 *
 * For queries, resolve `getPermissionsService(ctx.sessionManager.getSessionId())`
 * per use; the no-argument overload deliberately selects the parent/default.
 * Before publication either may be undefined. Registrations must reconcile at
 * session_start and permissions:ready, disposing old registrations on reload.
 */

import type { Authorizer } from "./authority/authorizer";
import type {
  DelegationIdentity,
  DelegationReady,
  DelegationState,
  PendingDelegatedWait,
} from "./authority/permission-delegation";
import { hasDelegationCloser } from "./authority/permission-delegation";
import type { ToolAccessExtractor } from "./tool-access-extractor-registry";
import type { ToolInputFormatter } from "./tool-input-formatter-registry";
import type { PermissionCheckResult, PermissionState } from "./types";

export type {
  Authorizer,
  AuthorizerVerdict,
} from "./authority/authorizer";

/**
 * The narrow review-log seam handed to a chain link at `authorize` time
 * (ADR 0007 §3, same injection pattern as {@link PermissionQuery}).
 *
 * A link uses it to record a positive decision trail to the permission review
 * log — `review` for the durable, default-on audit entry (one per handled
 * ask), `debug` for verbose or short-circuit detail gated behind the
 * `debugLog` toggle. The session's own logger is passed straight through, so a
 * link's entries land in the same `pi-permission-system-permission-review.jsonl`
 * as the gate decisions, keying to a gate entry by `requestId`.
 */
export interface AuthorizerLog {
  review(event: string, details?: Record<string, unknown>): void;
  debug(event: string, details?: Record<string, unknown>): void;
}
export type {
  DelegationIdentity,
  DelegationReady,
  DelegationState,
  PendingDelegatedWait,
} from "./authority/permission-delegation";
export type { PromptPermissionDetails } from "./authority/permission-prompter";
export type {
  ForwardedPromptContext,
  PermissionDecisionEvent,
  PermissionsReadyEvent,
  PermissionUiPromptEvent,
  PermissionUiPromptSource,
} from "./permission-events";
export {
  PERMISSIONS_DECISION_CHANNEL,
  PERMISSIONS_READY_CHANNEL,
  PERMISSIONS_UI_PROMPT_CHANNEL,
} from "./permission-events";
// The declaration bundle already inlines these through `PromptPermissionDetails`
// and `PermissionUiPromptEvent`; the named exports are what a consumer needs to
// annotate a variable of their own.
export type {
  PromptAnnotation,
  PromptEvidence,
  PromptPayload,
  PromptPayloadKind,
  PromptRequester,
  PromptRequestFacts,
} from "./presentation/prompt-payload";
export type { PermissionCheckResult, PermissionState, ToolInputFormatter };

/** Process-global key for the service slot. */
const SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");

/**
 * The narrow, read-only projection of {@link PermissionsService}: answer a
 * policy query for a surface, and report a tool-level state. This is the
 * capability an Authorizer chain link is handed (ISP) — it never sees the
 * registration surface.
 */
export interface PermissionQuery {
  /**
   * Query the permission policy for a surface and value.
   *
   * @param surface   - Permission surface: "bash", "read", "mcp", "skill",
   *                    "external_directory", etc.
   * @param value     - The value to evaluate: command string, tool name, skill
   *                    name, or path. Omit or pass `undefined` for a
   *                    surface-level query.
   * @param agentName - Optional agent name for per-agent policy resolution.
   * @returns Full check result including state, matched pattern, and origin.
   */
  checkPermission(
    surface: string,
    value?: string,
    agentName?: string,
  ): PermissionCheckResult;

  /**
   * Query the tool-level permission state for pre-filtering tools before
   * creating a child session.
   *
   * Returns `"deny"` | `"allow"` | `"ask"` based on the composed policy.
   * Does not consider command-level rules (e.g. per-bash-command patterns) —
   * use `checkPermission` for runtime invocation gates.
   *
   * @param toolName  - Tool name (e.g. `"bash"`, `"read"`, `"my-extension:tool"`).
   * @param agentName - Optional agent name for per-agent policy resolution.
   */
  getToolPermission(toolName: string, agentName?: string): PermissionState;
}

/**
 * Public interface exposed to other extensions via `getPermissionsService()`.
 *
 * `checkPermission` takes a surface + optional value + optional agent name,
 * and delegates to `PermissionManager.checkPermission()` with current session
 * rules internally.
 */
export interface PermissionsService extends PermissionQuery {
  /**
   * Register a custom preview formatter for a specific tool name.
   *
   * The formatter is consulted first inside `ToolPreviewFormatter.formatToolInputForPrompt`;
   * returning `undefined` falls through to the built-in switch (and ultimately
   * the JSON default).
   *
   * Only one formatter may be registered per tool name — a second call for the
   * same name throws.  The returned disposer unregisters the formatter.
   *
   * @param toolName  - Exact tool name to register for (e.g. `"mcp"`, `"my-server:run"`).
   * @param formatter - Receives the raw `input` record; return a string to use
   *                    as the prompt preview, or `undefined` to decline.
   */
  registerToolInputFormatter(
    toolName: string,
    formatter: ToolInputFormatter,
  ): () => void;

  /**
   * Register a custom access-intent extractor for a specific tool name.
   *
   * The extractor declares the filesystem path a tool will access so the
   * cross-cutting `path` and `external_directory` gates can see it. Use it for
   * tools whose path lives under a non-standard key — built-in file tools and
   * any tool exposing `input.path` (plus MCP via `input.arguments.path`) are
   * already covered by convention without registration.
   *
   * The extractor receives the raw `input` record and returns the path string,
   * or `undefined` to decline. Only one extractor may be registered per tool
   * name — a second call for the same name throws. The returned disposer
   * unregisters the extractor.
   *
   * @param toolName  - Exact tool name to register for (e.g. `"ffgrep"`).
   * @param extractor - Receives the raw `input` record; return the path string,
   *                    or `undefined` to decline.
   */
  registerToolAccessExtractor(
    toolName: string,
    extractor: ToolAccessExtractor,
  ): () => void;

  /**
   * Register a named live-authority chain link (ADR 0007 §4).
   *
   * A link reviews an `ask` and returns `allow` / `deny` (with an optional
   * teaching `reason`) / `defer`. It is handed a narrow, session-scoped
   * {@link PermissionQuery} at `authorize` time so it can query the
   * deterministic engine at gate parity. Register from a `permissions:ready`
   * handler so registration is robust to load order and survives `/reload`.
   *
   * Registration alone grants **no authority**: the link decides nothing until
   * the operator names it in the `authorizerChain` config (opt-in activation),
   * and the chain owner caps every verdict with the bounded-delegation
   * checkpoint (an `allow` on an excluded surface downgrades to `defer`). Only
   * one link may be registered per name — a second call for the same name
   * throws. The returned disposer unregisters the link.
   *
   * @param name      - Operator-facing link name referenced from `authorizerChain`.
   * @param authorize - The link's decision callback
   *                    (`(details, query, log) => verdict`); `log` is an
   *                    {@link AuthorizerLog} for recording a decision trail to
   *                    the shared permission review log.
   */
  registerAuthorizer(
    name: string,
    authorize: Authorizer["authorize"],
  ): () => void;

  /** Establish the required parent binding before the child can use its tools. */
  connectDelegation(
    identity: DelegationIdentity,
    options?: { signal?: AbortSignal },
  ): Promise<DelegationReady>;

  /** Read the current binding lifecycle; it grants no tool permission. */
  getDelegationState(): DelegationState;

  /** Observe immutable wait snapshots, immediately and on change. No decision authority. */
  subscribeDelegatedWaits(
    listener: (pending: readonly PendingDelegatedWait[]) => void,
  ): () => void;
}

// A separate process-global key keeps legacy publication distinct from every
// literal session ID, even when different module copies publish into one map.
const LEGACY_DEFAULT_KEY = Symbol.for(
  "@gotgenes/pi-permission-system:legacy-default",
);

type ServiceKey = string | typeof LEGACY_DEFAULT_KEY;

interface PublishedServices {
  services: Map<ServiceKey, PermissionsService>;
  defaultKey?: ServiceKey;
}

function isPublishedServices(value: unknown): value is PublishedServices {
  return (
    typeof value === "object" &&
    value !== null &&
    "services" in value &&
    (value as { services?: object }).services instanceof Map
  );
}

function getPublishedServices(): PublishedServices {
  const global = globalThis as Record<symbol, unknown>;
  const current = global[SERVICE_KEY];
  if (isPublishedServices(current)) {
    return current;
  }
  const services: PublishedServices = { services: new Map() };
  global[SERVICE_KEY] = services;
  return services;
}

/**
 * Store a service under its exact session id. The optional legacy form remains
 * for consumers compiled before exact-session access existed.
 */
export function publishPermissionsService(
  service: PermissionsService,
  sessionId?: string,
  options?: { asDefault?: boolean },
): void {
  const published = getPublishedServices();
  const key = sessionId ?? LEGACY_DEFAULT_KEY;
  const previous = published.services.get(key);
  if (previous && previous !== service && hasDelegationCloser(previous)) {
    previous.closeDelegation();
  }
  published.services.set(key, service);
  if (options?.asDefault ?? true) {
    published.defaultKey = key;
  }
}

/**
 * Retrieve a service for `sessionId`, or the currently published parent service
 * when no session id is supplied.
 */
export function getPermissionsService(
  sessionId?: string,
): PermissionsService | undefined {
  const global = globalThis as Record<symbol, unknown>;
  const current = global[SERVICE_KEY];
  if (!isPublishedServices(current)) {
    return undefined;
  }
  const published = current;
  const key = sessionId ?? published.defaultKey;
  return key === undefined ? undefined : published.services.get(key);
}

/**
 * Remove only entries still owned by `service`, preserving replacements that
 * reloaded under the same session id.
 */
export function unpublishPermissionsService(service: PermissionsService): void {
  const global = globalThis as Record<symbol, unknown>;
  const current = global[SERVICE_KEY];
  if (!isPublishedServices(current)) {
    return;
  }
  const published = current;
  for (const [key, publishedService] of published.services) {
    if (publishedService === service) {
      published.services.delete(key);
    }
  }
  if (
    published.defaultKey !== undefined &&
    published.services.get(published.defaultKey) === undefined
  ) {
    published.defaultKey = undefined;
  }
  if (published.services.size === 0) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property; the empty global slot must be removed.
    delete global[SERVICE_KEY];
  }
}
