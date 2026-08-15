# Troubleshooting

## Every Tool Call Opens a Dialog

This is the expected fallback when no matching hook returns `allow`.
Confirm that the global config exists, passes strict validation, and contains a `hooks.PreToolUse` matcher for the translated tool name.
Enable `permissionReviewLog` and inspect `permission_request.hook_diagnostic` entries for timeout, spawn, invalid-output, and non-zero-exit deferrals.

An old `permission` allow rule does not suppress the dialog in the hooks-first runtime.

## Hooks Do Not Run

Check these conditions:

1. The matcher is a valid regular expression.
2. The matcher targets the translated Claude Code-compatible name, such as `Bash`, `Read`, or `mcp__server__tool`.
3. The hook command is non-empty and executable through `sh -c`.
4. A trusted project is required before project-scoped hooks are loaded.
5. A higher-precedence project `hooks` value replaces the complete global hook set.

Use a matcher of `.*` temporarily to distinguish a name mismatch from a command failure.
Hook commands require a POSIX-compatible `sh` on `PATH`; stock Windows needs Git Bash, MSYS2, or another compatible shell.

## Hook Failure Opens the Dialog

Timeouts, spawn failures, malformed JSON, empty output, and non-zero exits other than `2` intentionally defer.
This direction is fail-safe because a broken hook cannot silently grant authority.

Exit code `2` is the exception: it blocks the tool and uses standard error as the denial reason.

## `allowLocalEdits` Does Not Approve an Edit

This is intentional.
`allowLocalEdits` only changes the hook input's `permission_mode` from `default` to `acceptEdits`.
The hook must still return `allow` for the edit to bypass the dialog.

## `yoloMode` Still Shows Dialogs

This is intentional in this fork.
`yoloMode` sends `permission_mode: "bypassPermissions"` to hooks but does not auto-approve tool calls.

## Old Web Access Settings Do Nothing

`allowWebAccess` and `allowedFetchDomains` are accepted only so old config files remain valid.
Move web-search and fetch-domain decisions into the `PreToolUse` hook.

## Policy, Shell Aliases, or Authorizer Chains Do Nothing

`permission`, `piInfrastructureReadPaths`, `shellTools`, and `authorizerChain` are compatibility fields and do not grant or deny production tool calls.
Remove them after migrating their intent into the hook implementation.

## Several Dialogs Replace One Another

The extension serializes permission transactions in FIFO order.
If replacement still occurs, verify that only one copy of the extension is loaded.
Check project and global Pi settings for duplicate source and npm entries.

## A Prompt Remains After a Session Switch

Session teardown aborts the active inline prompt and clears queued prompts.
If an external frontend keeps displaying a stale selection UI, reload that frontend; non-TUI selection surfaces may not expose a programmatic dismissal API.

## A Headless Call Is Blocked

A hook `allow` can approve a headless call.
A hook `ask` or `defer` requires a user-granted session rule, a serving parent session for subagent forwarding, or an interactive UI.
Without one of those authorities, the request fails closed.

## A Subagent Waits for Permission

Confirm that the parent session is active and serving its forwarding inbox.
For out-of-process children, confirm that `PI_SUBAGENT_PARENT_SESSION` is set to the parent session ID.
`forwardingTimeoutMs` bounds unanswered forwarding waits; an in-process target known not to be serving fails earlier.

## Config Is Rejected

The config schema is strict.
An unknown field rejects that scope and leaves calls on the dialog fallback path.
Use `schemas/permissions.schema.json` for editor validation and compare against `config/config.example.json`.

## Logs

Enable:

```json
{
  "debugLog": true,
  "permissionReviewLog": true
}
```

Logs live under `extensions/pi-permission-system/logs` in the active Pi agent directory.
A value bound to a sensitive key name is masked; a secret embedded inside a command string is not.
