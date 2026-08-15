<p align="center">
  <img src="docs/assets/logo.png" alt="pi-permission-system logo">
</p>

# @gotgenes/pi-permission-system

Hooks-first permission extension for the [Pi](https://pi.mariozechner.at/) coding agent.

> **Fork notice:** This package is based on [MasuRii/pi-permission-system](https://github.com/MasuRii/pi-permission-system), but its production authority model is intentionally different.
> The inherited deterministic policy engine remains for compatibility and inspection, but it does not authorize or deny production tool calls.

## Authority Model

Every registered tool call follows one path:

1. Run every matching Claude Code-compatible `PreToolUse` hook.
2. A merged hook decision of `allow` executes the tool immediately.
3. A merged hook decision of `deny` blocks the tool immediately.
4. A merged hook decision of `ask` or `defer` uses a prior user-granted session approval when one matches.
5. Otherwise, show exactly one permission dialog.

Hook decisions are merged with this priority:

```text
deny > ask > allow > defer
```

The hook always runs before session approvals, so a later hook denial can stop a previously approved pattern.
Configured `permission`, `shellTools`, `authorizerChain`, and yolo policy behavior do not bypass this flow.
An unexpected internal exception fails closed and blocks the tool call.

## Install

```bash
pi install npm:@gotgenes/pi-permission-system
```

A checkout of this repository can also be loaded directly because the root `package.json` declares `packages/pi-permission-system/src/index.ts` as a Pi extension.

## Quick Start

Create `~/.pi/agent/extensions/pi-permission-system/config.json`:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json",
  "allowLocalEdits": true,
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

`allowLocalEdits` does not approve edits.
It only sets the hook input's `permission_mode` to `acceptEdits`.

## Hook Protocol

Matchers are regular expressions over Claude Code-compatible tool names such as `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, and `mcp__server__tool`.
Commands execute through `sh -c`, so hooks require a POSIX-compatible `sh` on `PATH`.
Stock Windows without Git Bash, MSYS2, or another compatible shell defers each hook to the dialog with a `spawn_error` diagnostic.
Each matching command runs from the session working directory and receives JSON on standard input:

```json
{
  "session_id": "session-id",
  "cwd": "/workspace/project",
  "permission_mode": "acceptEdits",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "git status" },
  "tool_use_id": "tool-call-id",
  "transcript_path": "/path/to/session.jsonl"
}
```

A hook can return a decision on standard output:

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "allow",
    "permissionDecisionReason": "Read-only repository inspection"
  }
}
```

Supported decisions are `allow`, `deny`, `ask`, and `defer`.
Exit code `2` is treated as `deny`, with standard error used as the reason.
Empty output, malformed output, timeout, spawn failure, and other non-zero exits defer to the dialog and emit a `permission_request.hook_diagnostic` review-log entry.
`updatedInput` and `additionalContext` are parsed for protocol compatibility but are not applied.

An optional hook `if` field supports `Tool(pattern)` matching against common tool inputs:

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "check-destructive-command",
      "if": "Bash(rm -rf *)"
    }
  ]
}
```

## Permission Dialog

Only one interactive permission transaction is active at a time.
Concurrent asks wait in FIFO order instead of replacing one another.
Changing or shutting down the session cancels the active prompt and all queued prompts.

The dialog shows aligned request facts within `promptMaxRows` and `promptFieldMaxWidth` limits.
`Ctrl+O` expands it to the complete request.
The denial-reason field uses Pi's line editor and accepts pasted text, collapsing pasted newlines into spaces.

| Key | Decision                                      |
| --- | --------------------------------------------- |
| `y` | Approve once                                  |
| `s` | Approve the suggested pattern for the session |
| `n` | Deny                                          |
| `r` | Deny with a reason                            |

`doublePressToConfirm` controls whether a decision hotkey must be pressed twice.

## Configuration

| Scope   | Path                                                      |
| ------- | --------------------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pi-permission-system/config.json` |
| Project | `<cwd>/.pi/extensions/pi-permission-system/config.json`   |

Project configuration loads only for trusted projects.
A project `hooks` value replaces the complete global hook set.
Scalar runtime settings use project-over-global replacement.

| Field                    | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `hooks`                  | Claude Code-compatible `PreToolUse` commands         |
| `allowLocalEdits`        | Send `permission_mode: "acceptEdits"` to hooks       |
| `yoloMode`               | Send `permission_mode: "bypassPermissions"` to hooks |
| `doublePressToConfirm`   | Require confirmation of TUI decision hotkeys         |
| `forwardingTimeoutMs`    | Bound subagent forwarding waits                      |
| `promptMaxRows`          | Bound rendered prompt rows                           |
| `promptFieldMaxWidth`    | Bound each rendered prompt field                     |
| `reviewLogFieldMaxWidth` | Bound each structured review-log value               |
| `permissionReviewLog`    | Enable the structured permission review log          |
| `debugLog`               | Enable diagnostic logging                            |

`allowWebAccess`, `allowedFetchDomains`, `permission`, `piInfrastructureReadPaths`, `shellTools`, and `authorizerChain` are migration compatibility fields rather than production authority.
`toolInputPreviewMaxLength` and `toolTextSummaryMaxLength` are accepted but ignored; use the prompt rendering limits instead.
See [docs/configuration.md](docs/configuration.md) for the complete reference.

## Subagents

A child runs its own hook with the child session ID, working directory, transcript, and raw tool input.
If that hook asks or defers, the request is forwarded to the serving parent's dialog.
The parent neither reruns the child's hook nor consults `authorizerChain`.
A session grant can apply to the requesting child or to the whole serving session.

In-process serving state uses a process-global registry.
Out-of-process parents publish a filesystem heartbeat, allowing children to fail quickly when the target process is absent, stale, or serving another session.
Forwarded decisions retain the request ID and record both the responding session and its decision provenance.

## Logs and Events

Hook approvals and denials are written with explicit `pretooluse_hook` provenance.
Every permission request has a request ID shared by its review records and terminal broadcasts.
`permissions:ui_prompt` carries structured request facts immediately before a visible prompt.
`permissions:decision` reports hook decisions, dialog outcomes, gate errors, and served forwarded outcomes.

Review-log values are bounded by `reviewLogFieldMaxWidth`.
Values bound to sensitive key names are masked; a secret embedded inside a command string is not.

## Scope and Non-Goals

This package makes external hooks the automatic authority and provides a fail-closed interactive fallback.
It does not sandbox an approved operation, rewrite tool input, mutate model context from hook output, or infer whether a command is safe inside the core.
Those decisions belong in the configured hook implementation.

## Documentation

| Document                                                                                           | Contents                                        |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [docs/configuration.md](docs/configuration.md)                                                     | Configuration, hook protocol, dialog, and logs  |
| [docs/cross-extension-api.md](docs/cross-extension-api.md)                                         | Service accessor and permission event contracts |
| [docs/subagent-integration.md](docs/subagent-integration.md)                                       | Child hooks, forwarding, and liveness           |
| [docs/troubleshooting.md](docs/troubleshooting.md)                                                 | Common failures and diagnostics                 |
| [docs/migration/0745-prompt-payload-contracts.md](docs/migration/0745-prompt-payload-contracts.md) | Structured prompt and forwarding contracts      |
| [docs/migration/0746-review-log-fields.md](docs/migration/0746-review-log-fields.md)               | Structured review-log fields and width limits   |

## Development

```bash
pnpm --filter @gotgenes/pi-permission-system run check
pnpm --filter @gotgenes/pi-permission-system run lint
pnpm --filter @gotgenes/pi-permission-system run test
```

## License

[MIT](LICENSE)
