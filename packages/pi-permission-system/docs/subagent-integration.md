# Subagent Integration

## Native Integration with `@gotgenes/pi-subagents`

`@gotgenes/pi-subagents` publishes child-session lifecycle events on `pi.events`.
The permission system subscribes automatically, registers each in-process child in a process-global `SubagentSessionRegistry`, and unregisters it when the child is disposed.
No configuration is required when both extensions are installed.

The registry enables deterministic child detection and permission forwarding even though each Pi session has its own event bus and extension-module instance.

## Hooks-First Behavior

A child session runs its own configured `PreToolUse` hook before any forwarding occurs.
The hook receives the child's session ID, working directory, transcript path, translated tool name, and raw tool input.

- A child hook `allow` executes the call immediately.
- A child hook `deny` blocks it immediately.
- A child hook `ask` or `defer` uses a matching child session approval or forwards the request to the serving parent.

The parent does not rerun the child's hook and does not consult `authorizerChain`.
It uses a matching serving-session approval when one exists; otherwise it shows the permission dialog.

When the user approves a forwarded request for the session, the dialog offers two scopes:

1. The requesting child only, which is the least-privilege default.
2. The whole serving session, covering the parent and its children.

## Permission Forwarding

A non-UI child writes a structured request below the serving session's permission-forwarding directory and polls for a response.
The request carries the child's `PromptPayload`, display projection, approval suggestion, and permission request ID.
The parent renders those child-fixed facts under its own prompt budget and returns the decision through the response file.

The same request ID appears in the child and parent review records and in `permissions:ui_prompt` and `permissions:decision` broadcasts.
The child records the responding session and its nested decision provenance, distinguishing a human answer from a serving-session approval.

Forwarding files are owner-only but are not redacted because the parent must read the original request facts to render the prompt.

## Forwarding Liveness

A child should not wait the full `forwardingTimeoutMs` when nobody is draining the target inbox.
The serving session therefore publishes liveness on two channels:

- In-process children read the process-global serving-session registry.
- Out-of-process children read a heartbeat under `<agent-dir>/sessions/permission-forwarding/serving/`.

The heartbeat records the served session ID, process ID, and refresh time.
A missing, stale, dead-process, or wrong-session heartbeat causes the child to fail after a short grace period instead of waiting the normal forwarding timeout.
A live parent keeps refreshing while the user considers a prompt, so deliberation is not mistaken for abandonment.

Every abandonment path is reported as `confirmation_unavailable`, not as a user denial, because no user ruled on the request.
The denial reason identifies whether the target was unresolved, the request could not be written, the response could not be read, the target was not serving, or the timeout expired.

After upgrading the package, restart the serving parent before launching newer out-of-process children.
An older running parent publishes no heartbeat, which a newer child correctly treats as not serving.

## Other Subagent Extensions

Process-based subagent extensions must set `PI_SUBAGENT_PARENT_SESSION` to the serving parent session ID for forwarding to work.
Without that value, a headless `ask` or `defer` cannot reach an interactive authority and is blocked.

Tool visibility restrictions from another subagent extension remain independent of permission decisions:

1. A hidden tool never reaches the permission system.
2. A visible tool still runs through its `PreToolUse` hook.
3. Neither extension can silently re-enable a tool the other removed.

The retained `permission:` frontmatter field is parsed for compatibility but is not production authority in this hooks-first fork.
Move automatic child approvals and denials into the `PreToolUse` hook.