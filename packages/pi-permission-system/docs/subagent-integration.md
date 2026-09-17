# Subagent Integration

## Native Integration with `@gotgenes/pi-subagents`

`@gotgenes/pi-subagents` publishes child-session lifecycle events on `pi.events`.
The permission system subscribes automatically, registers each in-process child in a process-global `SubagentSessionRegistry`, and unregisters it when the child is disposed.
No configuration is required when both extensions are installed.

The registry enables deterministic child detection and permission forwarding even though each Pi session has its own event bus and extension-module instance.

## Explicit Interactive Delegation

An interactive child can keep `mode: "tui"` and `hasUI: true` while sending permission asks to its assigned parent's existing dialog.
This is explicit opt-in, not a consequence of subagent environment hints or pane focus.
The launcher must set `PI_PERMISSION_DELEGATION_REQUIRED=1` **before the permission extension factory runs**.
An invalid present value fails startup; an absent marker preserves ordinary interactive and legacy headless behavior.

Both processes must load this capability and share the same host, user, and Pi agent directory.
Mixed-version service-slot or delegated-runtime interoperability is not supported; this does not remove the separate legacy headless wire path described below.
The private transport requires atomic hard-link publication; unsupported filesystems fail closed.
This is cooperative integration, not a sandbox against another process with the same user's filesystem access.

### Adapter startup and reload

1. Keep task delivery and the configured child tools inactive until connection succeeds.
2. Register a `permissions:ready` listener during adapter factory setup, and also attempt initialization from the adapter's own `session_start`.
   Either provider/adapter load order must work.
3. Resolve `getPermissionsService(ctx.sessionManager.getSessionId())`, never the no-argument parent accessor.
   Feature-detect `connectDelegation` and `subscribeDelegatedWaits`; a missing or older provider is an activation failure.
4. Start one guarded asynchronous connection per service instance and return from `session_start` without awaiting a later extension's lifecycle handler.
   Pass `{ parentSessionId, childSessionId, agentName, childCwd }` using the assigned parent, actual child context, and configured agent name.
5. Await `connectDelegation(identity, { signal })` in that separate attempt.
   Only its `interactive-delegation-v1` acknowledgement permits task delivery and activation of the adapter's configured tools.
   The permission package never widens that tool set.
6. On reload, discard the old service reference and subscription, resolve the replacement exact-session service, and establish a fresh binding before reactivation.
   Ignore completion from an attempt whose service is no longer current; dispose your own ready-event and wait listeners on shutdown and prevent delayed initialization from reactivating a stopped child.
   A failed connection requires an explicit retry; it never falls back to local UI or an ambient parent ID.

Identical connections on the same live instance share their result; conflicting identities are rejected.
`getDelegationState()` reports `not-required`, `unbound`, `connecting`, `ready`, `unavailable`, or `closed`, with a binding and bounded failure code when applicable.
Readiness proves routing and liveness, not approval of any tool.
A delegated child cannot itself serve another delegated child.
The ordinary `permissions:ready` event means local service publication, **not** a completed cross-process handshake.

### Observe the entire wait

`subscribeDelegatedWaits(listener)` immediately supplies a copied, frozen array of `{ delegationId, childSessionId, requestId }` records, then another snapshot on each change.
A request enters before filesystem preparation and leaves in lifetime cleanup, including failures, cancellation, timeout, and denial.
Multiple requests remain independent; an empty set means no permission waits, not task completion.
The returned disposer only unsubscribes, and observer return values or failures cannot decide permissions.
Graceful teardown publishes an empty set before disposing observers.

The adapter maps nonempty snapshots to its activity and the host's supported blocked-state API.
It must also clear activity on child process exit, because a killed process cannot publish a final snapshot.
No Herdr-specific event or API is provided or assumed here; Shepard/Herdr adapter work and fresh interactive acceptance are separate requirements.
The child must not fabricate dialog events: `permissions:ui_prompt` stays on the parent that actually opens the dialog.

### Cancellation and settlement

Required delegation blocks tool calls **before hooks** until ready.
After readiness, the hooks-first behavior below remains unchanged.
The original tool-call abort signal is captured before asynchronous hooks and checked again before execution or a child-session grant.
A hook result arriving after that lifetime ends does not emit a live hook allow/deny verdict or terminal hook review entry; nonterminal execution diagnostics may remain.
The boundary audit records the blocked call, but there is no guaranteed cancellation broadcast.
Use the wait subscription and lifecycle/process-exit cleanup for activity reporting, not a presumed one-to-one dialog/decision event pair.
Parent model-turn cancellation does not cancel a waiting child; service shutdown/reload, deadline expiry, child cancellation, or detected binding loss does.
The parent services control messages while a human prompt is pending and serializes local and forwarded prompts through the same queue, including across replacement cleanup.

Each negotiated request binds its terminal outcome to the exact request ID, delegation ID, identity, and absolute deadline.
The first atomic terminal publication is the ordering point: cancellation that wins prevents approval and either session grant; a later human answer is inert.
Cancellation **after** a human decision commits blocks subsequent tool execution but does not revoke an already-valid serving-session grant.
Serving-scope approval is translated to ordinary approval for the child, so the child never duplicates the parent's grant.
Reasons, child-fixed facts, and nested decision provenance are preserved.
Legacy peers retain their existing wire path; a required delegate never downgrades to it.

If the server removes a negotiated request without successfully publishing a terminal, the requester ends that wait as unavailable at its next polling observation, not the full deadline.
It re-reads the correlated terminal because normal settlement also removes the request, then atomically arbitrates any unavailable outcome against a concurrent approval.
A committed approval retains its provenance and grant ownership subject to the original request lifetime; an unavailable winner prevents a late approval or either grant.
Only that wait is cleared; the healthy delegation and other pending waits remain usable.

The server rechecks PID/heartbeat liveness immediately before commit.
An abrupt death that is not yet detected can still race a valid human grant; there is no child-receipt round trip and no claim of instantaneous death detection.
Restart both parent and child after upgrading; editing a loaded extension does not update the current Pi process.

### Retained protocol records

Control acknowledgements, consumed-handshake records, revocation tombstones, and immutable request outcomes remain under `<agent-dir>/sessions/permission-forwarding/delegations/`.
There is no automatic pruning: retained records protect against replay and late publication across reloads, and disk usage grows with delegations and requests.
An age limit or a missing heartbeat alone is not a safe reason to discard that protection.

For offline cleanup, first stop **every parent and child Pi process using this agent directory** and ensure no launcher can restart them during cleanup.
Only then remove the `delegations/` subtree; do not remove unrelated session inboxes or session history.
Restart with fresh service instances and fresh connections, never by restoring an old binding or replaying saved protocol files.
Automatic bounded retention remains deferred.

## Hooks-First Behavior

Once any required delegation is ready, a child session runs its own configured `PreToolUse` hook before any forwarding occurs.
The hook receives the child's session ID, working directory, transcript path, translated tool name, and raw tool input.

- A child hook `allow` permits the call only while the captured request lifetime remains active.
- A live child hook `deny` blocks it with hook provenance; a cancelled call is instead blocked by its lifetime.
- A child hook `ask` or `defer` uses a matching child session approval or forwards the request to the serving parent.

The parent does not rerun the child's hook and does not consult `authorizerChain`.
It uses a matching serving-session approval when one exists; otherwise it shows the permission dialog.

When the user approves a forwarded request for the session, the dialog offers two scopes:

1. The requesting child only, which is the least-privilege default.
2. The whole serving session, covering the parent and its children.

## Permission Forwarding

A non-UI child writes a structured request below the serving session's permission-forwarding directory and polls for a response.
The request carries the child's `PromptPayload`, display projection, approval suggestion, permission request ID, creation time, and absolute deadline.
The deadline starts when the child creates the request, so inbox and permission-prompt queue time count toward the same budget.
The parent renders those child-fixed facts under its own prompt budget and returns a timely decision through the response file.

When emitted, child and parent review records and `permissions:ui_prompt`/`permissions:decision` broadcasts carry the same request ID.
These broadcasts are not a universal completion protocol and may be absent on cancellation or failed settlement.
The child records the responding session and its nested decision provenance, distinguishing a human answer from a serving-session approval.

Forwarding files are owner-only but are not redacted because the parent must read the original request facts to render the prompt.

## Forwarding Liveness

A child should not wait the full `forwardingTimeoutMs` when nobody is draining the target inbox.
The serving session therefore publishes liveness on two channels:

- In-process children read the process-global serving-session registry.
- Out-of-process children read a heartbeat under `<agent-dir>/sessions/permission-forwarding/serving/`.

The heartbeat records the served session ID, process ID, and refresh time.
For the legacy headless path, a missing, stale, dead-process, or wrong-session heartbeat causes the child to fail after a short grace period instead of waiting the normal forwarding timeout.
An explicit delegated binding instead becomes unavailable when its liveness check detects loss; it does not use that legacy grace period.
A live parent keeps refreshing while the user considers a prompt, so deliberation is not mistaken for abandonment.

Forwarding infrastructure failures mark confirmation unavailable rather than a human denial, because no user ruled on the request.
When a decision event is emitted, its resolution is `confirmation_unavailable`; cancellation and teardown still need the observation cleanup described above.
The denial reason identifies whether the target was unresolved, the request could not be written, the response could not be read, or the target was not serving; deadline expiry uses the fixed `Auto-approval could not approve this tool use` message described below.

The default unanswered-request deadline is two minutes (`120000` ms), and an explicit positive `forwardingTimeoutMs` may be shorter or longer.
Budgets below the 250-ms polling interval can expire against a healthy parent, including requests arriving between ticks; accepting a positive value does not guarantee a successful round trip.
The configured deadline is not silently enlarged.
Expiration closes an active TUI prompt, ends backend waiting for a non-TUI prompt, prevents queued prompts from opening, and blocks with exactly `Auto-approval could not approve this tool use`.
A late answer cannot create a grant or response.
A third-party RPC frontend that ignores the SDK timeout may keep stale visuals even though the backend has rejected its answer.
This permission deadline is independent of a subagent watchdog or run timeout; those supervise the child run rather than one forwarded permission request.

For the legacy headless wire path, full deadline protection requires updated child and parent processes.
A new parent serves an old request without a shared parent-side deadline, while a new child still stops waiting when an old parent ignores its deadline field.
This legacy deadline-field compatibility is not mixed-version support for the negotiated delegation protocol.
After upgrading the package, restart the serving parent before launching new children.

## Other Subagent Extensions

Legacy headless process-based subagent extensions must set `PI_SUBAGENT_PARENT_SESSION` to the serving parent session ID for forwarding to work.
Without that value, a headless `ask` or `defer` cannot reach an interactive authority and is blocked.

Tool visibility restrictions from another subagent extension remain independent of permission decisions:

1. A hidden tool never reaches the permission system.
2. A visible tool still runs through its `PreToolUse` hook.
3. Neither extension can silently re-enable a tool the other removed.

The retained `permission:` frontmatter field is parsed for compatibility but is not production authority in this hooks-first fork.
Move automatic child approvals and denials into the `PreToolUse` hook.
