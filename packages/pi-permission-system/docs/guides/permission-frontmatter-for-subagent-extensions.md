# Permission Frontmatter for Subagent Extensions

## Compatibility Notice

The inherited `permission:` frontmatter parser remains in the source tree, but frontmatter policy is not production authority in the hooks-first runtime.
Subagent extension authors should not document `permission:` as a way to grant or deny tool execution for this fork.

## Recommended Integration

A subagent extension should control only which tools it registers or activates for a child.
`pi-permission-system` then runs the configured `PreToolUse` hook for every registered child tool call.

The child hook receives:

- The child session ID.
- The child working directory.
- The child transcript path.
- The translated Claude Code-compatible tool name.
- The raw child tool input.
- The configured hook permission mode.

The hook can return `allow`, `deny`, `ask`, or `defer`.
An unresolved ask is forwarded to the serving parent session's dialog.

## Lifecycle Events

`@gotgenes/pi-subagents` publishes synchronous child lifecycle events on `pi.events`.
This package uses those events to register the child-to-parent relationship in its process-global registry before child extension binding begins.

Other in-process subagent extensions can integrate by emitting the same lifecycle contract:

```typescript
pi.events.emit("subagents:child:session-created", {
  sessionId: childSessionId,
  parentSessionId,
});
```

Dispose the relationship when the child ends:

```typescript
pi.events.emit("subagents:child:disposed", {
  sessionId: childSessionId,
});
```

Out-of-process children should set `PI_SUBAGENT_PARENT_SESSION` instead.

## Tool Visibility

A tool hidden or omitted by the subagent extension never reaches `PreToolUse` authorization.
A visible tool is not automatically approved; the hook must allow it or the user must approve it through the dialog or a prior session grant.

## Migration from `permission:` Frontmatter

Move automatic decisions into the hook implementation.
For example, replace a frontmatter `bash: deny` intent with a hook that returns `deny` for `Bash` calls from that agent.
Replace frontmatter allow rules with hook `allow` results.
Leave unresolved operations as `defer` so they reach the dialog.
