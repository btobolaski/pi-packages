# Subagent Integration

## Native Integration with `@gotgenes/pi-subagents`

[`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-subagents) publishes synchronous child-session lifecycle events on `pi.events`.
This package records those events in a process-global `SubagentSessionRegistry`, allowing the separately loaded child extension instance to recognize its parent relationship.

The integration provides:

1. Deterministic child-session detection.
2. A child-local `PreToolUse` hook invocation with the child's session ID, working directory, transcript path, tool name, and raw tool input.
3. Forwarding of hook `ask` and `defer` outcomes to the serving parent's dialog.
4. User-selected session grants scoped either to the requesting child or to the whole serving session.

No project policy or per-agent `permission:` frontmatter grants tool authority in the hooks-first runtime.

## Forwarding Flow

A child tool call follows this sequence:

1. The child runs every matching `PreToolUse` hook.
2. Hook `allow` executes locally and hook `deny` blocks locally.
3. Hook `ask` or `defer` checks the child's user-granted session rules.
4. An unresolved ask is written to the parent session's forwarding inbox.
5. The serving parent presents the request through its serialized permission dialog.
6. The decision is returned to the child.

The parent does not rerun the child hook.
The parent also does not consult `authorizerChain`; that compatibility field is dormant.

## Session Grant Scope

A forwarded “approve for session” decision offers two scopes:

- **This subagent only** records the pattern on the requesting child.
- **The whole session** records the pattern on the serving parent for the parent and future child requests.

The hook still runs before the session rule on later calls.
A hook denial can therefore block a call covered by an earlier user session grant.

## Liveness

An in-process child uses the process-global serving registry to determine whether its target parent is draining the forwarding inbox.
A target that is known not to be serving fails promptly instead of waiting for the complete forwarding timeout.
An out-of-process child cannot inspect the parent's registry and therefore uses `forwardingTimeoutMs`.

Every unavailable-authority path is reported separately from a user denial.
A user who was never shown a prompt did not deny the request.

## Out-of-Process Children

Out-of-process subagent implementations should set `PI_SUBAGENT_PARENT_SESSION` in the child environment.
The child uses that session ID as the forwarding target.

## Coexistence with Tool Visibility Controls

The hooks-first resolver exposes tools as `ask` rather than hiding them based on inherited policy.
A subagent extension may still omit tools from the child's registered or active tool set before this extension sees a call.
A tool absent from Pi's registry cannot be authorized by a hook.

## Logs

Forwarded requests and responses are stored in owner-restricted session directories.
Hook approvals and denials retain `pretooluse_hook` provenance in review logs and decision events.
The child request carries the final display surface and value so the parent dialog identifies the original operation.
