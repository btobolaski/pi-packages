# PermissionPrompter

`src/authority/permission-prompter.ts`

## Responsibility

`PermissionPrompter` brackets the ask-path flow with review-log entries and delegates the live decision to the selected `Authorizer` ([#555]):

1. **Review log — waiting** — write `permission_request.waiting` before the authorizer is consulted.
2. **`authorizer.authorize(details)`** — the selected `Authorizer` (`LocalUserAuthorizer`, `ParentAuthorizer`, or `DenyingAuthorizer`) resolves the decision.
   The UI-prompt broadcast and the UI/forwarding branching this class previously owned now live on the individual `Authorizer` implementations — see [architecture.md's authority model](architecture.md#target-the-authority-model).
3. **Review log — outcome** — write `permission_request.approved` or `permission_request.denied` with the final decision state and any denial reason.
   The denied entry's `resolution` is the decision state, or `confirmation_unavailable` when the decision carries that marker — a `DenyingAuthorizer` denial, i.e. no live authority was reachable (a no-UI, non-subagent session) ([#556]).

The normal outcome entry is written only when the `Authorizer` returns a decision.
If authorization rejects, including `InteractivePromptCancelledError` during a session transition, the error propagates and the original waiting entry remains without an approved/denied pair.
For direct tool calls, the fail-closed boundary records the terminal `permission_request.blocked` entry with `resolution: "gate_error"`; forwarded serving catches the escalation error and denies through its existing fail-closed path.

Yolo-mode auto-approval is resolved upstream, at the composition stage (`PermissionManager.check`'s `rewriteAsksToYolo`) — an `ask` never reaches this class under yolo, so `PermissionPrompter` has no yolo-mode knowledge.

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

`PermissionPrompter` no longer assembles or holds any UI/forwarding dependency — it receives the already-selected `Authorizer` as a call-time argument from `AuthorizerSelection.escalate(details)`, rather than threading `ExtensionContext` through a `forwarder.requestApproval(ctx, …)` call.
`AuthorizerSelection` (the rewrite of the former `PromptingGateway`) owns the selection: `selectAuthorizer(ctx, deps)` runs once per activation and returns the `Authorizer` for that context — `LocalUserAuthorizer` when `ctx.hasUI`, `ParentAuthorizer` when the context is a no-UI subagent, `DenyingAuthorizer` otherwise.

## Interactive serialization

One `SerialInteractivePromptQueue` is scoped to each `piPermissionSystemExtension()` factory instance.
Within one queue generation, `LocalUserAuthorizer` and `WebAccessPrompter` share that queue, so standard, parent-served forwarded, and per-domain web prompts cannot replace one another in the local TUI.

For standard and forwarded asks, `PermissionPrompter` writes `permission_request.waiting` before `LocalUserAuthorizer.authorize()` enters the queue.
For web-domain asks, `WebAccessPrompter` likewise writes the waiting entry before queue admission.
The `permissions:ui_prompt` event is emitted only after an interaction reaches the head of the queue, immediately before its UI transaction begins.

Each queue slot covers the complete interaction, not an individual `ui.select()` or `ui.input()` call.
A forwarded session-scope selector and an optional denial-reason input therefore remain contiguous with their initial permission selector.
If an interaction rejects, its original rejection reaches the caller and the queue admits the next interaction.
`SessionLifecycleHandler` invalidates the current queue generation at every `session_start` and `session_shutdown`.
Active and queued callers then receive `InteractivePromptCancelledError`, existing fail-closed boundaries block their requests, and a fresh generation can admit the new session without waiting for an abandoned dialog.
The active transaction receives an `AbortSignal`; the dialog helpers race every `ui.select()` and `ui.input()` against it so a stale selection cannot continue into a follow-up scope selector or denial-reason input.
Generation invalidation cannot cancel a Pi-core UI primitive that was already issued, so that underlying selector or input may remain unresolved while the fresh generation starts; cancelling or arbitrating the primitive itself requires Pi-core support.
The cancellation audit outcome follows the rejection behavior above: the waiting entry can remain unmatched by approved/denied, while the fail-closed boundary records the blocked request.

`ParentAuthorizer` is not queued: it performs file-based escalation in a child or other no-UI process.
A forwarded request joins the queue only when `ForwardedRequestServer` serves it through the parent's selected `LocalUserAuthorizer`, which is the local collision point.
`DenyingAuthorizer` is also unqueued because it performs no UI.
The queue coordinates and invalidates only this permission-system factory instance; Pi-core arbitration and global serialization across extensions are outside its scope.

## Wiring

`PermissionPrompter` and the shared interaction queue are instantiated once in `piPermissionSystemExtension()` (`src/index.ts`) and injected into `AuthorizerSelection`:

```typescript
const prompter = new PermissionPrompter({ logger });
const interactivePromptQueue = new SerialInteractivePromptQueue();

const authorizerSelection = new AuthorizerSelection({
  detection: subagentDetection,
  events: pi.events,
  queue: interactivePromptQueue,
  requestPermissionDecisionFromUi,
  forwardingDir: paths.forwardingDir,
  registry: subagentRegistry,
  logger,
  prompter,
});
```

`authorizerSelection` implements `AskEscalator` and is passed to both `PermissionSession` (as the `activate`/`deactivate` lifecycle) and `GateRunner` (as the `escalate(details)` ask-escalation role).
`GateRunner` calls `this.prompter.escalate(details)` for every `ask` — there is no `canConfirm()` pre-check ([#556] dissolved it); the selected `Authorizer` always answers, the `DenyingAuthorizer` by denying with the `confirmationUnavailable` marker.
The Authorizer spine is entirely behind that seam.

## Per-domain web prompt

`WebAccessPrompter` is a separate local-only sibling used by `ToolCallOverrides` for `fetch_content` domain decisions.
The caller reaches it only when `allowWebAccess` is enabled, the URL has a parseable hostname, the effective tool check is not already allowed, and `ctx.hasUI` is true.
It writes the same waiting and outcome review entries as `PermissionPrompter`, emits `permissions:ui_prompt`, and presents one-off, persistent, session, deny, and deny-with-reason choices.
It does not use the `Authorizer` spine or permission forwarding because the specialized domain choices require a local UI and the no-UI path deliberately falls back to the standard tool policy.

```typescript
const webAccessPrompter = new WebAccessPrompter(
  logger,
  pi.events,
  interactivePromptQueue,
);
const toolCallOverrides = new ToolCallOverrides(
  session,
  webAccessPrompter,
  reporter,
  logger,
);
```

A persistent approval delegates to `PermissionSession.persistAllowedFetchDomain`, which uses `ConfigStore`'s global atomic-save path.
A failed persistent save becomes a session-only approval so the already-approved immediate request can proceed without pretending persistence succeeded.

[#555]: https://github.com/gotgenes/pi-packages/issues/555
[#556]: https://github.com/gotgenes/pi-packages/issues/556
