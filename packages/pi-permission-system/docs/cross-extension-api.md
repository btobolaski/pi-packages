# Event API

> **Hooks-first runtime:** Policy queries return `ask` unless a user-granted session approval matches.
> `registerAuthorizer` remains available for source compatibility, but configured authorizer chains are dormant.
> Tool input formatters still shape the final dialog; access extractors do not grant or deny tool execution.

The extension provides two cross-extension integration surfaces:

1. **Service accessor** (preferred) — a `Symbol.for()`-backed synchronous API on `globalThis` for direct policy queries.
2. **Event bus** — broadcasts on `pi.events` for observation.

---

## Service Accessor

The preferred way for other extensions to query the permission policy is the `Symbol.for()`-backed service accessor.
It provides direct, synchronous, type-safe function calls.

### Quick Start

Inside a tool or command handler after startup, use its current `ctx` to query the exact session.
Before publication the accessor returns `undefined`; startup consumers must use the [load-order-safe wiring](#end-to-end-wiring) below rather than a factory-only lookup.

```typescript
try {
  const { getPermissionsService } = await import(
    "@gotgenes/pi-permission-system"
  );
  const permissions = getPermissionsService(ctx.sessionManager.getSessionId());
  if (permissions) {
    const result = permissions.checkPermission("bash", "git push");
    console.log(result.state); // "allow" | "deny" | "ask"
  }
} catch {
  // Not installed — graceful degradation
}
```

### How It Works

Pi's extension loader creates a fresh [jiti](https://github.com/nicolo-ribaudo/jiti) instance per extension with `moduleCache: false`, which isolates module-level state.
`Symbol.for()` and `globalThis` are process-global by spec, so they survive this isolation.

At `session_start`, every permission-system instance publishes its service in a session-keyed map on `globalThis` via `Symbol.for("@gotgenes/pi-permission-system:service")`.
`getPermissionsService(sessionId)` returns only that session's service, or `undefined`; use this overload to configure an interactive child's delegation.
`getPermissionsService()` preserves the parent/default accessor: registered children and required delegates do not replace its selection.
Even when `import()` loads a fresh module copy, both overloads read the same map.
Replacement and teardown are identity-checked, so a retired instance cannot unpublish its replacement.
A consumer with the current session ID can resolve that service after its `permissions:ready` broadcast, emitted at `session_start` after publication.
The event also fires for children whose service never becomes the no-argument default; it does not mean delegated routing is ready.

All types below are directly importable and type-check with `tsc` out of the box.
`@gotgenes/pi-permission-system`'s published `exports` resolve `import type { … }` to a self-contained, bundled declaration file with no internal module references, so a downstream `tsconfig.json` needs no special path configuration.

### Interactive delegation lifecycle

These service operations manage an explicitly required child's lifecycle; they do not make permission decisions.
Existing callers of query/registration methods remain supported, but implementations and test doubles of the full `PermissionsService` interface must now provide all three required delegation methods.
They are not optional; feature detection in an adapter handles an unavailable capability, not mixed-version service-slot or delegated-runtime interoperability.

```typescript
interface DelegationIdentity {
  parentSessionId: string;
  childSessionId: string;
  agentName: string;
  childCwd: string;
}

interface DelegationReady {
  capability: "interactive-delegation-v1";
  delegationId: string;
  parentSessionId: string;
  childSessionId: string;
}

interface PendingDelegatedWait {
  readonly delegationId: string;
  readonly childSessionId: string;
  readonly requestId: string;
}

// Additions to PermissionsService:
interface DelegationService {
  connectDelegation(
    identity: DelegationIdentity,
    options?: { signal?: AbortSignal },
  ): Promise<DelegationReady>;
  getDelegationState(): DelegationState;
  subscribeDelegatedWaits(
    listener: (pending: readonly PendingDelegatedWait[]) => void,
  ): () => void;
}
```

`DelegationService` above is illustrative; the exported interface is `PermissionsService`.
`DelegationIdentity`, `DelegationReady`, `DelegationState`, and `PendingDelegatedWait` are named package exports.
The lifecycle states are `not-required`, `unbound`, `connecting`, `ready`, `unavailable`, and `closed`.
Failure codes are `not_required`, `invalid_identity`, `conflicting_identity`, `unavailable`, `cancelled`, and `closed`.
State snapshots are frozen; both ready and unavailable states retain the validated identity and delegation ID.

The subscription immediately returns an immutable snapshot through the listener and then reports each pending-set change.
It carries no raw inputs, human reasons, or decision callbacks.
Unsubscribing has no authority over a request.
No lifecycle operation accepts a verdict or records a grant.

See [explicit interactive delegation](subagent-integration.md#explicit-interactive-delegation) for the required environment marker, load-order-safe startup, cancellation ordering, and reload recipe.
Do not await a later extension's `session_start` handler from your own handler, and do not treat `permissions:ready` as a completed delegation handshake.

### API

The existing query/registration methods remain available (excerpt; the full interface also includes authorizer registration and the required delegation operations above):

```typescript
interface PermissionsService {
  /** Query the permission policy for a surface and value. */
  checkPermission(
    surface: string,
    value?: string,
    agentName?: string,
  ): PermissionCheckResult;

  /** Query tool-level permission state for pre-filtering before session creation. */
  getToolPermission(toolName: string, agentName?: string): PermissionState;

  /**
   * Register a custom preview formatter for a specific tool name.
   * Returns a disposer that unregisters the formatter.
   * Throws if a formatter is already registered for that tool name.
   */
  registerToolInputFormatter(
    toolName: string,
    formatter: (input: Record<string, unknown>) => string | undefined,
  ): () => void;

  /**
   * Register a custom access-intent extractor for a specific tool name.
   * Declares the filesystem path a tool accesses so the `path` and
   * `external_directory` gates can see it. Returns a disposer; throws if an
   * extractor is already registered for that tool name.
   */
  registerToolAccessExtractor(
    toolName: string,
    extractor: (input: Record<string, unknown>) => string | undefined,
  ): () => void;
}
```

#### `checkPermission`

| Parameter   | Required | Description                                                                              |
| ----------- | -------- | ---------------------------------------------------------------------------------------- |
| `surface`   | Yes      | Permission surface: `"bash"`, `"read"`, `"mcp"`, `"skill"`, `"external_directory"`, etc. |
| `value`     | No       | Value to evaluate (command, name, path); defaults to `""`                                |
| `agentName` | No       | Agent name for per-agent policy resolution                                               |

Returns `PermissionCheckResult` with fields `state`, `matchedPattern`, `source`, `origin`, etc.

For a path-shaped surface (`path`, `external_directory`, or a path-bearing tool — `read`/`write`/`edit`/`grep`/`find`/`ls`), the supplied `value` is matched against both the path as given and its canonical (symlink-resolved) form, at parity with the gates — so a query for a symlinked path matches a rule on its real target.

For the `bash` surface, a `value` containing a chained or nested command (joined by `&&`, `||`, `;`, `|`, `&`, or newlines, or nested in a command substitution/subshell) is decomposed into its command-pattern units and resolved most-restrictive (`deny` > `ask` > `allow`), at parity with the enforcement gate — so `cd /repo && npm install x` returns the decision of the `npm install x` unit, not the leading `cd`.
A previously chained command that returned `allow` (riding an allowed leading command) may therefore now return `deny`/`ask`.
Decomposition needs the tree-sitter parser, which is warmed at `before_agent_start` (before any tool call); a bash query in the brief pre-warm window falls back to a whole-string match, so the answer is never weaker than the gate — only strengthened once warm.

#### `getToolPermission`

Returns `"allow"` | `"deny"` | `"ask"` for a tool name without considering command-level rules.
Use this to pre-filter a tool list before creating a child session — it avoids calling `checkPermission` per tool and interpreting the full result.

```typescript
const denied = tools.filter(
  (t) => permissions.getToolPermission(t, agentName) === "deny",
);
```

#### `registerToolInputFormatter`

Register a custom preview formatter for a specific tool name.
Permission ask-prompts call your formatter while building the prompt text, so you can show a human-readable summary of a tool call instead of the default truncated JSON.

```typescript
registerToolInputFormatter(
  toolName: string,
  formatter: (input: Record<string, unknown>) => string | undefined,
): () => void; // returns a disposer
```

Registration rules:

- One formatter per tool name.
  A second `register` for the same name throws — there is no silent override.
- The returned disposer unregisters the formatter.
  It is identity-guarded, so a stale disposer cannot evict a later registration of the same name.

##### Which tool name to key on

The `toolName` you register is matched against the **registered Pi tool name** the agent invoked — not against MCP server/tool pairs.

- For a tool your extension registers directly with Pi, use that tool's exact name (the same string Pi shows in `pi.getAllTools()`).
- For **MCP** calls, every server tool arrives as the single umbrella `"mcp"` tool, with the real target in `input.tool` (e.g. `"exa:search"`).
  You therefore cannot register a formatter per `server:tool`.
  The `"mcp"` name is already claimed by the built-in summarizer (below), and because duplicate registration throws, you cannot replace it.
  If you need richer per-server MCP previews, open an issue — that requires a chained-formatter model this seam does not yet provide.
- `"bash"` never reaches your formatter: bash prompts take a dedicated branch that shows the command directly.

##### What your formatter receives

The `input` argument is the raw tool-call input object exactly as the agent supplied it (the tool's arguments).
It is always a plain record; shapes by tool:

| Tool                   | `input` shape                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `mcp` (umbrella)       | `{ tool: "server:tool", server?, arguments?: object, … }` — summarize `input.arguments` |
| `read`                 | `{ path, offset?, limit? }`                                                             |
| `write`                | `{ path, content }`                                                                     |
| `edit`                 | `{ path, edits?: […] }` or `{ path, oldText, newText }`                                 |
| `grep` / `find` / `ls` | `{ pattern?, glob?, path? }`                                                            |
| your own tool          | whatever input schema your tool registered                                              |

Treat every field as untrusted: the agent can emit malformed or partial input, so read defensively (type-check before use) rather than assuming a shape.

##### What your return value does

The returned string is spliced into the middle of the prompt sentence:

```text
Agent 'Explore' requested tool 'deploy' <your fragment>. Allow this call?
```

Return a short grammatical fragment that reads naturally in that slot — e.g. `"with target staging (3 services)"` or `"runs 2 commands"`, not a full sentence and not raw JSON.

Return semantics:

- Return a **string** to use it verbatim as the preview (this also overrides the built-in preview for built-in tools like `read`/`edit`).
- Return **`undefined`** to decline — the prompt falls through to the built-in formatter for that tool, and finally to the truncated-JSON default.
  Prefer `undefined` over `""` when you have nothing useful to add: an empty string short-circuits the fallthrough and suppresses the default preview entirely.

##### Your formatter must not throw

The core does **not** wrap your formatter in a `try/catch`.
A thrown error propagates into prompt construction and can break the permission prompt — a denial-of-service on the gate.
Guard your own parsing and return `undefined` on anything unexpected.

##### End-to-end wiring

Listen during factory setup and also try from your own `session_start`.
Either provider/consumer handler order works: a ready event before the consumer has a context is recovered by its startup lookup, and a consumer starting first retries when the provider publishes.
The lookup happens after the asynchronous import, so delayed imports cannot install registrations after shutdown or against a cached superseded service.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionsService } from "@gotgenes/pi-permission-system";

export default function myExtension(pi: ExtensionAPI): void {
  let sessionId: string | undefined;
  let current: PermissionsService | undefined;
  let disposeFormatter: (() => void) | undefined;
  let stopped = false;
  const provider = import("@gotgenes/pi-permission-system").catch(() => undefined);

  function register(): void {
    void provider.then((api) => {
      if (!api || stopped || !sessionId) return;
      const next = api.getPermissionsService(sessionId);
      if (next === current) return;
      disposeFormatter?.();
      disposeFormatter = undefined;
      current = undefined;
      if (!next) return;
      disposeFormatter = next.registerToolInputFormatter("deploy", (input) => {
        const target = typeof input.target === "string" ? input.target : undefined;
        if (!target) return undefined;
        const services = Array.isArray(input.services) ? input.services.length : undefined;
        return services !== undefined
          ? `with target ${target} (${services} services)`
          : `with target ${target}`;
      });
      current = next;
    }).catch((error: unknown) => {
      console.warn("Permission formatter registration failed", error);
    });
  }

  const unsubscribe = pi.events.on("permissions:ready", register);
  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    register(); // Do not await a provider whose session_start may run later.
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    sessionId = undefined;
    unsubscribe();
    disposeFormatter?.();
    disposeFormatter = undefined;
    current = undefined;
  });
}
```

Reload note: on `/reload`, the permission-system publishes a fresh service backed by a new registry, so previous registrations are dropped.
Register against each newly published exact-session service, disposing your own old registration first; repeated notifications for the same instance are no-ops.
On consumer reload the factory installs fresh listeners; shutdown disposes both the listener and formatter, and delayed import callbacks remain inert.

##### Recommended practices

- Keep previews short — they appear inline in a yes/no prompt, and the result is truncated by the configured preview length anyway.
- Never surface secrets (tokens, keys, full request bodies) in a preview; summarize counts and identifiers instead.
- Parse defensively and return `undefined` on malformed input — never throw.
- Return a grammatical fragment, not raw JSON or a full sentence.
- Register idempotently on each extension load; dispose on `session_shutdown`.

##### Built-in MCP summarizer

A built-in formatter is registered for the `"mcp"` tool at startup (through this same public API).
It renders a compact `with key: value, …` summary of the call's `arguments` and returns `undefined` when there are no arguments, leaving the MCP target prompt unchanged.
This is the reference implementation for the seam — see `src/builtin-tool-input-formatters.ts`.

#### `registerToolAccessExtractor`

Declare the filesystem path a tool will access so the cross-cutting `path` and `external_directory` gates can evaluate it.

```typescript
registerToolAccessExtractor(
  toolName: string,
  extractor: (input: Record<string, unknown>) => string | undefined,
): () => void; // returns a disposer
```

You usually do **not** need this.
Path gating is on by default for every tool whose input follows the convention:

- Built-in file tools (`read`, `write`, `edit`, `find`, `grep`, `ls`) and any tool exposing `input.path` are extracted automatically.
- MCP calls are extracted from `input.arguments.path`.
- `bash` is never extracted here — it has its own token-based path gates.

Register an extractor only when a tool carries its path under a **non-standard key** (e.g. `input.target` or `input.file`).
Return the path string, or `undefined` to decline.

```typescript
const dispose = permissions.registerToolAccessExtractor("ffgrep", (input) =>
  typeof input.target === "string" ? input.target : undefined,
);
```

Registration rules mirror `registerToolInputFormatter`: one extractor per tool name (a second `register` for the same name throws), and the returned disposer is identity-guarded.
The extractor must not throw — guard your parsing and return `undefined` on anything unexpected.

#### Subagent session registration

In-process subagent registration is event-driven.
`@gotgenes/pi-subagents` emits `subagents:child:session-created` before `bindExtensions()` and `subagents:child:disposed` in the run's `finally`; the permission system subscribes automatically — no service call from the spawner is required.
See [Subagent Integration](subagent-integration.md) for details.

### Reload Safety

During `/reload`, all extensions re-initialize.
The permission-system re-publishes a fresh service at `session_start`; teardown is identity-scoped, so a superseded generation's shutdown only clears the slot when it still owns it and cannot wipe the new service.
Consumers must resolve again after publication, not assume a factory-time lookup sees the replacement.
Use `getPermissionsService(ctx.sessionManager.getSessionId())` per query; registrations need the startup/ready-event reconciliation shown above.
Reserve the no-argument accessor for deliberately querying the parent/default service.

### Graceful Degradation

`getPermissionsService(sessionId)` returns `undefined` until that session's service is published, and after it is unpublished.
The no-argument accessor may remain `undefined` in a child even after its own service is published.
The `import()` throws if the package is not installed.
Wrap both in `try/catch` + `if` guard as shown in the Quick Start example.

---

## Event Bus

The extension also emits events on Pi's `pi.events` bus so other extensions can observe permission decisions and integrate with the policy system without importing this package.

## Stability Guarantee

Fields may be added to any payload, but existing fields will not be removed or renamed without a semver-major version bump.
The broadcast contract is defined by the published TypeScript types plus package semver — broadcast payloads (`permissions:ready`, `permissions:ui_prompt`, `permissions:decision`) carry no `protocolVersion`.
Consumers should read broadcast payloads defensively (field-presence checks) rather than version-gating — that is robust to any shape skew between independently-versioned sibling extensions.

All three broadcasts are best-effort: a throwing listener cannot block permission handling, session startup, or gate resolution.

## Channel Reference

| Channel                 | Direction | When                                         | Payload type              |
| ----------------------- | --------- | -------------------------------------------- | ------------------------- |
| `permissions:ready`     | Broadcast | At `session_start`, after publish            | `PermissionsReadyEvent`   |
| `permissions:ui_prompt` | Broadcast | Before active UI prompt                      | `PermissionUiPromptEvent` |
| `permissions:decision`  | Broadcast | When a gate or served ask reports a decision | `PermissionDecisionEvent` |

---

## UI Prompt Broadcasts

The permission system emits `permissions:ui_prompt` immediately before it invokes the active user-facing permission UI.
This event is for integrations such as notification extensions that should alert only when the user needs to respond to a permission prompt.
It is not a generic "permission request entered waiting state" event, and it does not imply the prompt will be approved.
Terminal decisions that resolve without an active UI prompt, such as `hook_approved`, `hook_denied`, or `session_approved`, do not emit this event.
Neither legacy headless nor explicitly delegated interactive children emit this event merely by forwarding; the parent UI session emits it immediately before showing the forwarded permission dialog.
A forwarded request covered by a serving-session approval is answered without a prompt and emits no event; the event fires only when the parent is actually about to ask the human.
When the serving path reports a terminal decision, it emits `permissions:decision` on the parent's bus too.
Do not rely on that broadcast as a universal completion signal: cancellation, shutdown, or failed settlement may end a request without one; use delegated wait snapshots and process-exit cleanup for blocked activity.
A shown forwarded prompt can end with `confirmation_unavailable` when its request deadline expires; this uses the existing event shape and resolution value.
Forwarded prompts that do reach the human are not degraded: the parent emits the child's original `source` and the same `surface`/`value` display projection, plus a populated `forwarding` context identifying the requesting subagent.

The payload is lean by design — `surface`/`value` are the normalized display projection a notification consumer reads, not a mirror of the internal review log.
Read defensively rather than version-gating: broadcast payloads carry no `protocolVersion`.

The event carries no assembled sentence.
It carries `request`, the permission ask's invariant core, verbatim from the prompt payload — no evidence and no annotations.
The bus is the narrowest renderer: any loaded extension can observe it without the operator having named that extension, whereas every other route to an ask's evidence requires that consent (a registered tool-input formatter, or an `Authorizer` link the operator lists in `authorizerChain`).

```typescript
import type { PermissionUiPromptEvent } from "@gotgenes/pi-permission-system";

pi.events.on("permissions:ui_prompt", (raw) => {
  const event = raw as PermissionUiPromptEvent;
  // Defensive read: tolerate any shape skew between sibling extensions.
  if (typeof event.value !== "string") {
    return;
  }
  notify(event.surface, event.value, event.request.matchedPattern);
  // e.g. "bash" "git push" "git *"
});
```

### Payload Fields

| Field        | Type                             | Description                                                                                                   |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `requestId`  | `string`                         | ID of the permission request being prompted                                                                   |
| `source`     | `PermissionUiPromptSource`       | Prompt origin; `skill_input` is retained compatibility and is not emitted directly by the hooks-first runtime |
| `surface`    | `string \| null`                 | Normalized display surface when known                                                                         |
| `value`      | `string \| null`                 | Normalized command, path, skill name, or other display value when known                                       |
| `agentName`  | `string \| null`                 | Active or requesting agent name when known                                                                    |
| `request`    | `PromptRequestFacts`             | The ask's invariant core, without evidence or annotations                                                     |
| `forwarding` | `ForwardedPromptContext \| null` | Forwarding context, or `null` for a direct prompt                                                             |

Forwarding is orthogonal to origin: a forwarded subagent prompt keeps its original `source` and is identified by a non-null `forwarding` field, not by a dedicated source value.

#### `PromptRequestFacts`

The facts every render of the ask shows, that no renderer's budget may elide.
Nested rather than flattened so the event and the prompt payload share one shape: a fact added here reaches the bus without a second hand-maintained declaration.

| Field             | Type                         | Description                                                                                      |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `requester`       | `PromptRequester`            | Who is asking, and whether the ask arrived from a subagent                                       |
| `surface`         | `string`                     | The **gate** surface the rule fired on — `"external_directory"`, `"path"`, `"bash"`, a tool name |
| `toolName`        | `string \| null`             | The gated tool name; `null` when the ask is not tool-shaped                                      |
| `invokedToolName` | `string \| null`             | The invoked name when a shell alias re-exposes bash under another name                           |
| `value`           | `string`                     | The decision-relevant value: the command, path, MCP target, or skill name                        |
| `matchedPattern`  | `string \| null`             | The matched rule, including a sentinel such as `<indirection-bash-wrapper>`                      |
| `commandContext`  | `BashCommandContext \| null` | Where the offending bash unit runs, when it came from a substitution or subshell                 |
| `executedUnit`    | `string \| null`             | For bash, the unit that will actually run, including inside an unstrippable wrapper              |

`PromptRequester` carries `agentName` (`string | null`), `forwarded` (`boolean`), and `sessionId` (`string | null`, the requesting session for a forwarded ask).

The top-level `surface` and `request.surface` are two different facts and both belong on the event.
The top-level one is the **display** projection — the child's tool name, what a notification shows.
`request.surface` is the **gate** surface the rule fired on: a `read` of a path outside the working directory displays as `"read"` and gates on `"external_directory"`.

#### `ForwardedPromptContext`

Present for forwarded asks from either legacy headless children or explicitly delegated interactive children.

| Field                | Type             | Description                                    |
| -------------------- | ---------------- | ---------------------------------------------- |
| `requesterAgentName` | `string \| null` | Requesting subagent's display name, when known |
| `requesterSessionId` | `string \| null` | Requesting subagent's session id, when known   |

The `surface`/`value` pair is a deliberate display projection that replaces the redundant per-source fields (`command`/`path`/`target`/`skillName`/`toolName`/`toolCallId`/`toolInputPreview`/`sessionLabel`) from earlier drafts — none of which the notification use case reads.
The stability guarantee is additive, so any can be reintroduced in a later minor when a concrete consumer needs them.

---

## Decision Broadcasts

Decision-producing gates emit `permissions:decision`; this is not a universal tool-call completion or cancellation channel.
Active hook decisions use `hook_approved` or `hook_denied`; hook asks and deferrals leave reporting to the subsequent session-approval or dialog path.
A hook result arriving after its captured lifetime ended emits neither a terminal hook verdict nor a terminal hook approval/denial review entry; execution diagnostics may still be logged.
The tool-call boundary records the blocked result in its `DecisionAudit` without promising a cancellation broadcast.
This is useful for dashboards, telemetry, or audit overlays.

A session serving another session's forwarded request normally reports its committed escalated decision on its own bus.
That is what makes a forwarded prompt clearable: the ask is gated in the requesting session — a different process for an out-of-process subagent — so without it the serving session broadcasts a `permissions:ui_prompt` whose outcome never appears.
A forwarded request the serving session's own policy allows or denies is answered without a prompt and broadcasts nothing, matching the UI-prompt channel.
A served decision carries a non-null `forwarding` context; the requester reports its own gate decision when the answer is applied to a still-active request.

The `requestId` is the same id the request's review-log entries carry, and the same one `permissions:ui_prompt` carried if the request reached a prompt — so a prompt and its outcome are joinable, as are two concurrent prompts for the same command.
A reported outcome on the prompt's own bus uses that same request ID, including normal dialog-failure and deadline outcomes.
These best-effort broadcasts are not a durable exactly-once completion protocol; consumers must also clear their activity on lifetime teardown or process exit.
It identifies a permission *request*, not a tool call: one tool call runs several gates and so raises several requests, each with its own id.
Use the review log's `toolCallId` to join back to the Pi transcript.

```typescript
pi.events.on("permissions:decision", (raw) => {
  const event = raw as import("@gotgenes/pi-permission-system").PermissionDecisionEvent;
  console.log(event.surface, event.result, event.resolution);
  // e.g. "bash" "allow" "user_approved_for_session"
});
```

### Payload Fields

| Field            | Type                                        | Description                                                   |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `requestId`      | `string`                                    | ID of the permission request this decision resolves           |
| `surface`        | `string`                                    | Permission surface such as `bash`, `read`, `mcp`, or `skill`  |
| `value`          | `string`                                    | Command, tool name, skill name, or path that was evaluated    |
| `result`         | `"allow" \| "deny"`                         | Final outcome                                                 |
| `resolution`     | `string`                                    | How the outcome was reached                                   |
| `origin`         | `string \| null`                            | Provenance such as `pretooluse_hook`, `session`, or `builtin` |
| `agentName`      | `string \| null`                            | Active agent name when known                                  |
| `matchedPattern` | `string \| null`                            | Pattern from the winning rule when applicable                 |
| `forwarding`     | `ForwardedPromptContext \| null` (optional) | Requesting subagent on a decision served by this session      |

### Resolution Values

The published union retains full-policy values for compatibility.
The hooks-first production composition does not emit the rows marked **retained**.

| Value                         | Runtime status | Meaning                                                                                     |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `policy_allow`                | Retained       | Full-policy config rule allowed without a prompt                                            |
| `policy_deny`                 | Retained       | Full-policy config rule denied without a prompt                                             |
| `session_approved`            | Active         | Covered by an earlier user-granted session approval                                         |
| `infrastructure_auto_allowed` | Retained       | Full-policy infrastructure read bypass                                                      |
| `user_approved`               | Active         | User approved once via dialog                                                               |
| `user_approved_for_session`   | Active         | User approved for the rest of the session                                                   |
| `user_denied`                 | Active         | User denied via dialog                                                                      |
| `auto_approved`               | Retained       | Full-policy yolo approval without a dialog                                                  |
| `confirmation_unavailable`    | Active         | Confirmation was required but no authority answered before it became unavailable or expired |
| `gate_error`                  | Active         | The hook or fallback gate threw and the call was blocked fail-closed                        |
| `hook_approved`               | Active         | A `PreToolUse` hook approved the tool call                                                  |
| `hook_denied`                 | Active         | A `PreToolUse` hook denied the tool call                                                    |

---

## Ready Event

Each permission-system instance emits `permissions:ready` at `session_start`, after publishing its exact-session service (including on `/reload`).
Resolve `getPermissionsService(sessionId)` with the current context's ID; a child's event does not select a parent/default service and does not imply `connectDelegation` has succeeded.
The provider may publish before or after the consumer's own startup handler, so use both triggers in the [wiring example](#end-to-end-wiring) and never await a later lifecycle handler.

The payload is intentionally empty (`Record<string, never>`): the channel announces publication, not cross-process permission readiness.
It carries no `protocolVersion` — the broadcast contract is defined by the published types plus package semver.

Keep readiness listeners scoped to your extension instance and dispose them during shutdown, as the complete example does.
