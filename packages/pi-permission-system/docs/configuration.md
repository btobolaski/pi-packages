# Configuration Reference

## Authority Boundary

`PreToolUse` hooks are the only automatic production authority over tool calls.
A hook `allow` executes the tool, a hook `deny` blocks it, and `ask` or `defer` falls through to a prior user-granted session approval or one interactive dialog.

The inherited deterministic policy engine remains for compatibility, diagnostics, and migration.
Its `permission`, `shellTools`, and `authorizerChain` configuration does not authorize or deny production tool calls in this fork.

## Config File Locations

| Scope   | Path                                                      |
| ------- | --------------------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pi-permission-system/config.json` |
| Project | `<cwd>/.pi/extensions/pi-permission-system/config.json`   |

`PI_CODING_AGENT_DIR` replaces the default `~/.pi/agent` root when set.
Project config loads only after Pi reports that the project is trusted.
An untrusted project therefore cannot replace global hooks or runtime settings.

## Full Example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json",
  "debugLog": false,
  "permissionReviewLog": true,
  "yoloMode": false,
  "allowLocalEdits": true,
  "zellijTabAlert": false,
  "doublePressToConfirm": true,
  "forwardingTimeoutMs": 600000,
  "promptMaxRows": 24,
  "promptFieldMaxWidth": 400,
  "reviewLogFieldMaxWidth": 1000,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "moriarty hooks exec",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## Active Fields

### `hooks`

`hooks.PreToolUse` is an ordered array of matcher groups.
Each group has a required regular-expression `matcher` and at least one command hook.

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/check-tool-use.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Pi tool names are translated before matcher evaluation:

| Pi tool           | Hook tool name      |
| ----------------- | ------------------- |
| `bash`            | `Bash`              |
| `read`            | `Read`              |
| `write`           | `Write`             |
| `edit`            | `Edit`              |
| `grep`            | `Grep`              |
| `find`            | `Glob`              |
| `ls`              | `LS`                |
| `skill`           | `Skill`             |
| MCP `server:tool` | `mcp__server__tool` |

Unknown extension tool names pass through unchanged.
The matcher is anchored against the complete translated name.
For example, `Bash|Read` matches either complete name, while `Bash.*` also matches longer names.

A project-level `hooks` value replaces the complete global hook set.
Matcher arrays are not concatenated across scopes.

### Hook Command Fields

| Field     | Required | Meaning                                                           |
| --------- | -------- | ----------------------------------------------------------------- |
| `type`    | Yes      | Must be `"command"`                                               |
| `command` | Yes      | POSIX command run by `sh -c` with hook JSON on standard input     |
| `timeout` | No       | Positive timeout in seconds; defaults to `10`                     |
| `if`      | No       | Additional `Tool(pattern)` wildcard condition over the tool input |

```jsonc
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "check-removal",
      "if": "Bash(rm -rf *)"
    }
  ]
}
```

Wildcard `*` matches any sequence and `?` matches one character.

### Hook Input

Every matching hook command receives one JSON document on standard input:

```json
{
  "session_id": "session-id",
  "cwd": "/workspace/project",
  "permission_mode": "acceptEdits",
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_input": { "path": "src/app.ts" },
  "tool_use_id": "tool-call-id",
  "transcript_path": "/path/to/session.jsonl"
}
```

The command inherits the Pi process environment and runs from `cwd` through `sh -c`.
Hooks require a POSIX-compatible `sh` on `PATH`; stock Windows without Git Bash, MSYS2, or another compatible shell records `spawn_error` and defers to the dialog.
`transcript_path` is omitted when Pi does not expose a session file.
Matching commands run sequentially in configuration order.

### Hook Output and Exit Status

A command can return a decision using the Claude Code `hookSpecificOutput` shape:

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "The requested operation is destructive"
  }
}
```

| Result                                       | Behavior                                           |
| -------------------------------------------- | -------------------------------------------------- |
| `allow`                                      | Execute without a dialog                           |
| `deny`                                       | Block and report the hook reason                   |
| `ask`                                        | Use a matching session approval or show the dialog |
| `defer`                                      | Use a matching session approval or show the dialog |
| Exit `2`                                     | Deny; standard error becomes the reason            |
| Empty or malformed output                    | Defer                                              |
| Timeout, spawn error, or other non-zero exit | Defer                                              |

Multiple hook results merge as `deny > ask > allow > defer`.
Reasons from results with the winning decision are retained in the terminal message.
`updatedInput` and `additionalContext` are recognized but ignored because this extension owns authorization rather than tool-input rewriting or model-context mutation.

### `allowLocalEdits`

`allowLocalEdits: true` sends `permission_mode: "acceptEdits"` to hooks.
It does not approve `write` or `edit` calls and does not bypass the dialog.

Default: `false`.

### `yoloMode`

`yoloMode: true` sends `permission_mode: "bypassPermissions"` to hooks.
It does not auto-approve an `ask` and does not bypass the dialog by itself.
When both `yoloMode` and `allowLocalEdits` are true, `bypassPermissions` takes precedence.

Default: `false`.

### `doublePressToConfirm`

Require a second press of a TUI decision hotkey before committing it.
The first press arms the decision and displays a confirmation hint.
RPC and frontend select dialogs keep their ordinary single-selection flow.

Default: `true`.

### `zellijTabAlert`

`zellijTabAlert: true` marks the serving Zellij tab and Pi pane only while a real human-facing permission dialog is active.
It prefixes the tab name with "🔔 " (the bell followed by one ASCII space) and sets only the Pi pane background to dark red (`#5f0000`).
This renames the tab; it does not color the tab-bar entry.
The integration is plugin-free and requires the `list-panes`, stable tab/pane targeting, and pane-color commands available in Zellij 0.44.0 or newer.

The serving UI session owns the alert, including when a parent displays a forwarded subagent request.
A non-UI subagent does not mark its own tab or pane.
Disabling the setting, running outside Zellij, or lacking `ZELLIJ_PANE_ID` leaves permission behavior unchanged.

When the dialog exits, the extension restores the original tab name only if the marked name is still unchanged, so a manual rename made while the dialog is open is preserved.
It resets the pane background to the terminal default on approval, denial, cancellation, session replacement, extension reload, and shutdown.
The reset cannot restore an arbitrary custom pane color that existed before the dialog.

All Zellij command, timeout, parsing, and discovery failures are cosmetic and fail open.
They appear only in the debug log when `debugLog` is enabled, never as warning notifications, and do not change permission decisions, forwarding, or prompt events.

Default: `false`.

### Prompt Rendering Limits

`promptMaxRows` limits the rows rendered before evidence is elided.
The request's core facts are never removed by this budget.
Default: `24`.

`promptFieldMaxWidth` limits the characters shown from any one field.
Default: `400`.

`Ctrl+O` expands the TUI prompt to the complete request regardless of either limit.

### `forwardingTimeoutMs`

This is the maximum time in milliseconds a child waits for a serving parent to answer a forwarded ask.
An in-process target known not to be serving fails after a short grace period regardless of this value.
Out-of-process targets use the parent's filesystem heartbeat and also fail quickly when the heartbeat is missing, stale, dead, or names another session.

Default: `600000`.

### Logging Fields

`permissionReviewLog` enables structured permission request and decision events.
Default: `true`.

`debugLog` enables verbose diagnostic events.
Default: `false`.

`reviewLogFieldMaxWidth` limits every string value written to the review log and adds an ellipsis when shortened.
Default: `1000`.
This is a length limit, not redaction.

A value bound to a sensitive key name is masked; a secret embedded in a bash command string is not.

## Dialog and Session Approvals

Only one interactive permission transaction is active at a time.
Concurrent prompts wait in FIFO order.
A session switch or shutdown cancels the active prompt and every queued prompt.

The prompt renders one aligned fact per line and uses the configured row and field budgets.
The denial-reason field delegates to Pi's line editor, including paste, movement, deletion, kill-ring, and undo behavior.
Pasted line breaks become spaces because the reason remains one line.

| Key | Decision                                      |
| --- | --------------------------------------------- |
| `y` | Approve once                                  |
| `s` | Approve the suggested pattern for the session |
| `n` | Deny                                          |
| `r` | Deny with a reason                            |

The hook runs before the session-approval lookup on every call.
A hook denial therefore remains authoritative when the user previously approved a matching session pattern.

## Subagent Behavior

A child runs its own hook before forwarding.
The hook input carries the child's session ID, working directory, transcript path, tool name, and raw tool input.
When the child hook asks or defers, the final dialog request is forwarded to the serving parent.
The parent does not rerun the hook or consult `authorizerChain`.

The structured request retains the child's permission request ID and prompt payload.
A forwarded session grant can apply either to the requesting child or to the whole serving session.
The terminal record distinguishes the serving session from the human, session approval, or other authority that decided within it.

## Compatibility Fields

These fields remain accepted so existing config files do not fail strict validation during migration:

| Field                       | Runtime behavior                                     |
| --------------------------- | ---------------------------------------------------- |
| `allowWebAccess`            | Ignored                                              |
| `allowedFetchDomains`       | Ignored                                              |
| `permission`                | Parsed and inspectable, but not production authority |
| `piInfrastructureReadPaths` | Ignored by tool-call authorization                   |
| `shellTools`                | Ignored by the hooks-first runtime                   |
| `authorizerChain`           | Ignored by the hooks-first runtime                   |
| `toolInputPreviewMaxLength` | Deprecated and ignored                               |
| `toolTextSummaryMaxLength`  | Deprecated and ignored                               |

Remove these fields after migrating their intended behavior into the hook implementation.

## Merge Behavior

Scalar active fields use higher-scope replacement.
Project `hooks` replaces global `hooks` as one complete value.
A malformed strict config rejects that scope; with no valid matching hooks, tool calls fall back to the dialog rather than being silently approved.

## Review Records and Broadcasts

Each permission request receives a unique request ID.
Terminal hook decisions write structured review records and emit `permissions:decision` with `hook_approved` or `hook_denied` and origin `pretooluse_hook`.
Hook asks and deferrals do not emit a terminal result until a session approval, dialog, or unavailable authority resolves them.
Gate errors emit a fail-closed terminal decision under their own request ID.
A parent that displays a forwarded prompt emits the matching terminal decision on its own event bus when that prompt settles.
