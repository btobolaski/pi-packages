# PermissionPrompter

`src/authority/permission-prompter.ts`

## Responsibility

`PermissionPrompter` brackets the ask-path flow with review-log entries and delegates the live decision to the selected `Authorizer` ([#555]):

1. **Review log — waiting** — write `permission_request.waiting` before the authorizer is consulted.
2. **`authorizer.authorize(details)`** — the selected `Authorizer` (`LocalUserAuthorizer`, `ParentAuthorizer`, or `DenyingAuthorizer`) resolves the decision.
   The UI-prompt broadcast and the UI/forwarding branching this class previously owned now live on the individual `Authorizer` implementations — see [architecture.md's authority model](architecture.md#the-authority-model).
3. **Review log — outcome** — normalize an expired forwarded decision, then write `permission_request.approved` or `permission_request.denied` with the final decision state, any denial reason, and the decision's `decidedBy` provenance ([#726]).
   The denied entry's `resolution` is the decision state, or `confirmation_unavailable` when the decision carries that marker — either no live authority was reachable or a forwarded request exhausted its deadline.

Only the outcome entries carry `decidedBy`; the waiting entry does not, because nothing has decided yet and a `null` there would read as decided-by-nobody.
The prompter records what the decision states rather than deriving it, which lets one entry distinguish a human at the dialog, an unreachable authority, and another session's answer.

`PreToolUseHookGate` resolves hook `allow` and `deny` before an ask reaches this class.
The dialog fallback resolver preserves user session grants and converts every other production tool result to `ask`; yolo rewriting is disabled in the composition root.
`LocalUserAuthorizer` admits the complete prompt transaction through `SerialInteractivePromptQueue`, so the UI-prompt broadcast occurs only when that transaction reaches the front of the queue.
A forwarded request supplies one absolute deadline and request-local abort signal; queue time and every UI step consume the same budget, while direct prompts supply no such deadline.
The queue keeps ordering tied to the underlying interaction cleanup, so cancelling a queued request cannot bypass an unfinished predecessor.
Session teardown still invalidates the whole queue, and the inline prompt observes the combined abort signal so its active component also settles.

## Why a class instead of a free function

The previous implementation was `promptPermission(runtime, forwardingDeps, ctx, details)` in `runtime.ts`.
Adding a new field to `PromptPermissionDetails` (e.g. `sessionLabel` in #51) required touching four files: `types.ts` → `runtime.ts` → `polling.ts` → `index.ts`.

With `PermissionPrompter`, adding a new field touches two files:

- `src/authority/permission-prompter.ts` — add the field to `PromptPermissionDetails`.
- The `Authorizer` implementation(s) that read the new field — currently `local-user-authorizer.ts` and `approval-escalator.ts` (`ParentAuthorizer`).

Handler code and wiring in `index.ts` are unaffected.

## Interfaces

```typescript
interface PermissionPrompterApi {
  prompt(authorizer: Authorizer, details: PromptPermissionDetails): Promise<PermissionPromptDecision>;
}

interface PermissionPrompterDeps {
  logger: ReviewLogger; // review-log bracketing only
}
```

`PermissionPrompterApi` is the narrow seam `AuthorizerSelection` depends on (not the concrete class) — a private field on the concrete class would create a nominal brand a structural test mock (`{ prompt: vi.fn() }`) cannot satisfy without a cast.

`Authorizer` is the single live-authority role, defined in `src/authority/authorizer.ts`:

```typescript
interface Authorizer {
  authorize(details: PromptPermissionDetails): Promise<PermissionPromptDecision>;
}
```

## Relationship to the Authorizer spine

`PermissionPrompter` no longer assembles or holds any UI/forwarding dependency — it receives the already-selected `Authorizer` as a call-time argument from `AuthorizerSelection.prompt(details)`, rather than threading `ExtensionContext` through a `forwarder.requestApproval(ctx, …)` call.
`AuthorizerSelection` owns the selection: `selectAuthorizer(ctx, deps)` returns a `SelectedAuthority` whenever the context is activated, including before each tool call.
Explicit required delegation takes precedence over `ctx.hasUI` and ambient subagent detection:

- A ready binding selects `ParentAuthorizer`, even when the child has its own interactive TUI.
- A required but unready binding selects `DenyingAuthorizer`; it never falls back to child-local confirmation.
- Both required-delegation cases set `adjudicatesLocally: false`, so the child resolves no chain links.

Without required delegation, selection remains `LocalUserAuthorizer` for `ctx.hasUI`, `ParentAuthorizer` for a no-UI subagent, and `DenyingAuthorizer` otherwise.
The ordinary relaying `ParentAuthorizer` also sets `adjudicatesLocally: false` (one chain per node, ADR 0007 §7).
See [Explicit Interactive Delegation](../subagent-integration.md#explicit-interactive-delegation) for the readiness and binding lifecycle.

## Wiring

`PermissionPrompter` is instantiated once in `piPermissionSystemExtension()` (`src/index.ts`) and injected into `AuthorizerSelection`:

```typescript
const prompter = new PermissionPrompter({ logger });
const promptQueue = new SerialInteractivePromptQueue();

const authorizerSelection = new AuthorizerSelection({
  ...(delegationRequired ? { delegation } : {}),
  detection: subagentDetection,
  events: pi.events,
  getPromptPreferences: () => ({
    doublePressToConfirm: configStore.current().doublePressToConfirm,
    budget: resolveRenderBudget(configStore.current()),
  }),
  promptQueue,
  requestPermissionDecision,
  forwardingDir: paths.forwardingDir,
  registry: subagentRegistry,
  serving: servingLiveness,
  getForwardingTimeoutMs: () =>
    configStore.current().forwardingTimeoutMs ?? PERMISSION_FORWARDING_TIMEOUT_MS,
  logger,
  prompter,
  getPermissionQuery: () => permissionsService,
  authorizerRegistry,
  getAuthorizerChain: () => [],
});
```

`authorizerSelection` implements `AskEscalator` and is passed to both `PermissionSession` (as the `activate`/`deactivate` lifecycle) and `GateRunner` (as the `escalate(details)` ask-escalation role).
`GateRunner` calls `this.prompter.escalate(details)` for every `ask` — there is no `canConfirm()` pre-check ([#556] dissolved it); the selected `Authorizer` always answers, the `DenyingAuthorizer` by denying with the `confirmationUnavailable` marker.
The Authorizer spine is entirely behind that seam.

[#555]: https://github.com/gotgenes/pi-packages/issues/555
[#556]: https://github.com/gotgenes/pi-packages/issues/556
[#726]: https://github.com/gotgenes/pi-packages/issues/726
