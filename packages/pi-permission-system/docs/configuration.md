# Configuration Reference

## Config File Locations

One unified config file per scope:

| Scope   | Path                                                                                       |
| ------- | ------------------------------------------------------------------------------------------ |
| Global  | `~/.pi/agent/extensions/pi-permission-system/config.json` (respects `PI_CODING_AGENT_DIR`) |
| Project | `<cwd>/.pi/extensions/pi-permission-system/config.json`                                    |

Higher-precedence scopes override lower; see [Merge Precedence](#merge-precedence) for the full order.

> **Coming from OpenCode?**
> This extension's permission model was inspired by OpenCode's.
> See [OpenCode Compatibility](opencode-compatibility.md) for shared concepts, divergences, and a porting guide.

<!-- -->

> **Tip:** All `~/.pi/agent` paths shown in this document are defaults.
> If the `PI_CODING_AGENT_DIR` environment variable is set, Pi uses that directory instead.

## Merge Precedence

**Precedence order (later wins):**

1. Global config file
2. Project config file
3. Global agent frontmatter
4. Project agent frontmatter

The `permission` object uses deep-shallow merge: string-vs-string replaces; both-object shallow-merges pattern maps; string-vs-object the override wins entirely.
Scalar fields (`debugLog`, `permissionReviewLog`, `yoloMode`, `allowLocalEdits`, `allowWebAccess`) use simple replacement.
`allowedFetchDomains` is unioned across scopes (dedup by lowercase).
`hooks` are read from the global config only — project config and agent frontmatter do not contribute or override hooks.

## Full Example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json",

  // Runtime knobs
  "debugLog": false,
  "permissionReviewLog": true,
  "yoloMode": false,
  "allowLocalEdits": false,
  "allowWebAccess": false,
  "allowedFetchDomains": [],
  "toolInputPreviewMaxLength": 400,
  "toolTextSummaryMaxLength": 120,
  "piInfrastructureReadPaths": [],

  // Flat permission policy
  "permission": {
    "*": "ask",                              // universal fallback
    "path": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "read": "allow",
    "write": "deny",
    "edit": "deny",
    "bash": { "git status": "allow", "git *": "ask" },
    "mcp": { "mcp_status": "allow" },
    "skill": { "*": "ask" },
    "external_directory": "ask"
  }
}
```

> **Note:** Trailing commas are **not** supported.
> If parsing fails, the extension falls back to `ask` for all categories.

## Runtime Knobs

| Key                         | Default | Description                                                                                                                                                                          |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `debugLog`                  | `false` | Enables verbose diagnostic logging to `logs/pi-permission-system-debug.jsonl`                                                                                                        |
| `permissionReviewLog`       | `true`  | Enables the permission request/denial review log at `logs/pi-permission-system-permission-review.jsonl`                                                                              |
| `yoloMode`                  | `false` | Auto-approves `ask` results instead of prompting when yolo mode is enabled                                                                                                           |
| `allowLocalEdits`           | `false` | Auto-approves the tool-level check for `edit` / `write` inside `cwd`; cross-cutting `path` / `external_directory` gates and later PreToolUse hooks still apply                       |
| `allowWebAccess`            | `false` | Auto-approves `web_search` / `get_search_content`, and enables the per-domain `fetch_content` dialog                                                                                |
| `allowedFetchDomains`       | `[]`    | Persistent domain allow-list for `fetch_content`; lowercased and deduplicated                                                                                                        |
| `toolInputPreviewMaxLength` | `200`   | Max characters of inline JSON shown in permission prompts for tool inputs. Omit to use the default. Set a large value to disable truncation.                                        |
| `toolTextSummaryMaxLength`  | `80`    | Max characters of inline pattern/path summaries in permission prompts. Omit to use the default.                                                                                     |
| `piInfrastructureReadPaths` | `[]`    | Extra directories to auto-allow for reads, bypassing the `external_directory` gate. Supports `~`/`$HOME` expansion and wildcard patterns (`*`, `?`).                                 |
| `hooks`                     | n/a     | PreToolUse hook configuration (Claude Code-compatible). See [PreToolUse Hooks](#pretooluse-hooks).                                                                                   |

Both logs write to `~/.pi/agent/extensions/pi-permission-system/logs/`.
No debug output is printed to the terminal.

### `piInfrastructureReadPaths` patterns

Each entry is either a plain directory prefix or a wildcard pattern.
Plain entries match any path that starts with the given directory (after `~`/`$HOME` expansion).
Wildcard entries use `*` (any characters, including `/`) and `?` (exactly one character).
`*` and `**` are equivalent — both cross directory boundaries.

Example — allow reads from a Homebrew-managed Pi install at any version:

```jsonc
{
  "piInfrastructureReadPaths": [
    "/opt/homebrew/**/@earendil-works/pi-coding-agent/**"
  ]
}
```

---

## Policy Reference

### `permission["*"]` — Universal Fallback

The `"*"` key sets the action used when no surface-specific rule matches:

```jsonc
{
  "permission": {
    "*": "ask"
  }
}
```

Omitting `"*"` defaults to `"ask"` (least privilege).

### Tool Surfaces

Any registered tool name can be a surface key.
A string value is a catch-all for that surface.

| Surface example                               | Description                         |
| --------------------------------------------- | ----------------------------------- |
| `read`, `write`, `edit`, `grep`, `find`, `ls` | Canonical Pi built-in file tools    |
| `bash`                                        | Shell command execution             |
| `mcp`                                         | Registered MCP proxy tool           |
| `task`                                        | Delegation tool                     |
| `third_party_tool`                            | Any other registered extension tool |

```jsonc
{
  "permission": {
    "read": "allow",
    "write": "deny",
    "third_party_tool": "ask"
  }
}
```

Unknown or absent tools are not required in the config.
If a tool is not registered at runtime, this extension blocks it before permission checks run.

#### Path Patterns for File Tools

For path-bearing tools (`read`, `write`, `edit`, `find`, `grep`, `ls`), an object value maps file-path patterns to actions.
Patterns are matched against `input.path` using the same last-match-wins wildcard semantics as bash command patterns.
`*` matches zero or more of any character **including** path separators — `src/*` matches both `src/foo.ts` and `src/deep/nested/foo.ts`.
There is no single-segment vs. multi-segment distinction; `**` is not a supported token and behaves identically to `*`.

```jsonc
{
  "permission": {
    "read": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "write": {
      "*": "deny",
      "src/*": "allow",
      "tests/*": "allow"
    },
    "edit": {
      "*": "ask",
      "*.lock": "deny"
    }
  }
}
```

String shorthand is still supported and behaves identically — `"read": "allow"` is equivalent to `"read": { "*": "allow" }`, which permits reads of any path.

Tool injection at agent start is unaffected: a config like `"read": { "*": "allow", "*.env": "deny" }` still exposes the `read` tool to the agent.
Only specific paths are restricted at call time.

### `bash` Surface

Command patterns use wildcards matched against each top-level command in the chain:

- `*` matches zero or more of any character (including `/` and other separators — there is no single-segment vs. multi-segment distinction; `**` is not a supported token and is equivalent to `*`).
- `?` matches exactly one character.

**Last matching rule wins** within a single command — put broad catch-alls first, specific overrides after.

A bash invocation may be a chain of commands joined by `&&`, `||`, `;`, `|`, `&`, or newlines.
Each top-level command is evaluated independently against the patterns, and the most restrictive result wins (`deny` > `ask` > `allow`).
So `cd /repo && npm install x` evaluates both `cd /repo` and `npm install x`; if `npm *` is denied, the whole invocation is denied even when `cd *` is allowed.

Quotes are respected (an operator inside `'…'` or `"…"` does not split the command).
Commands nested inside command substitution (`$(…)`, backticks), process substitution (`<(…)`/`>(…)`), and subshells (`( … )`) are evaluated against the bash patterns too, in addition to their enclosing command — since those inner commands really execute.
So `echo $(rm -rf foo)` evaluates both `echo $(rm -rf foo)` and the inner `rm -rf foo`; if `rm *` is denied, the whole invocation is denied.
The deny reason and the approval prompt note the nested origin (e.g. `inside command substitution`).
Control-flow bodies (`if`/`while`/`for`/`case`) and `{ … }` brace groups are not descended into; their contents are matched as part of the enclosing statement's text.

A pattern ending with `*` (space + wildcard) also matches the bare command without arguments.
For example, `"git *"` matches both `"git status"` and bare `"git"`.
Use a more specific pattern before it to carve out exceptions.

> **Patterns match individual commands, not whole chains.**
> A pattern that embeds a chain operator (e.g. `"cd * && npm *"`) will not match, because each command in the chain is evaluated separately.
> Write one pattern per command instead.

```jsonc
{
  "permission": {
    "bash": {
      "*": "ask",
      "git status": "allow",
      "git diff": "allow",
      "git *": "ask",
      "rm -rf *": "deny"
    }
  }
}
```

String shorthand sets a catch-all for all bash commands:

```jsonc
{
  "permission": { "bash": "allow" }
}
```

### `mcp` Surface

MCP permissions match against derived targets from tool input:

| Target type       | Examples                                                              |
| ----------------- | --------------------------------------------------------------------- |
| Baseline ops      | `mcp_status`, `mcp_list`, `mcp_search`, `mcp_describe`, `mcp_connect` |
| Server name       | `myServer`                                                            |
| Server/tool combo | `myServer:search`, `myServer_search`                                  |
| Generic           | `mcp_call`                                                            |

```jsonc
{
  "permission": {
    "mcp": {
      "*": "ask",
      "mcp_status": "allow",
      "mcp_list": "allow",
      "myServer:*": "ask",
      "dangerousServer": "deny"
    }
  }
}
```

> **Note:** Baseline discovery targets auto-allow when any explicit `mcp: allow` rule exists.

String shorthand grants broad MCP access — useful for per-agent overrides:

```yaml
# ~/.pi/agent/agents/researcher.md (respects PI_CODING_AGENT_DIR)
---
name: researcher
permission:
  mcp: allow
---
```

### `skill` Surface

Skill name patterns use `*` and `?` wildcards (note: surface is `skill`, not `skills`):

```jsonc
{
  "permission": {
    "skill": {
      "*": "ask",
      "dangerous-*": "deny",
      "librarian": "allow"
    }
  }
}
```

### `path` Surface

Cross-cutting gate that applies to **all** file access — both Pi tools (`read`, `write`, `edit`, `find`, `grep`, `ls`) and bash commands.
A `path` deny cannot be overridden by a per-tool allow.

```jsonc
{
  "permission": {
    "path": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow",
      "~/.ssh/*": "deny"
    }
  }
}
```

The path gate runs before the external-directory and tool gates.
If it denies, the command is blocked without reaching subsequent gates — no wasted prompts.

For bash commands, the extension extracts path-candidate tokens from the command (dot-files like `.env`, relative paths like `src/foo.ts`, and absolute paths) and evaluates each against the path rules.
The most restrictive result across all tokens determines the outcome.

Four orthogonal layers compose with most-restrictive-wins:

| Layer                   | Question                                | Applies to       |
| ----------------------- | --------------------------------------- | ---------------- |
| `path`                  | Is this specific path pattern allowed?  | All tools + bash |
| `external_directory`    | Is accessing outside CWD ok?            | All tools + bash |
| Per-tool patterns       | Is this path ok for this specific tool? | Individual tools |
| `bash` command patterns | Is this command ok?                     | Bash only        |

Configs without a `path` key behave identically to before — the gate does not fire.
When no `path` key is present, the universal fallback (`permission["*"]`) applies: `"*": "allow"` keeps the gate transparent, while `"*": "deny"` would deny all file access via every surface including `path`.

> **Ordering matters.**
> Rules use last-match-wins.
> `{ "*.env": "deny", "*": "allow" }` allows `.env` because `"*"` is last and matches everything.
> Put the catch-all first: `{ "*": "allow", "*.env": "deny" }`.

#### `.env` recipe

Deny all env files but allow the example template:

```jsonc
{
  "permission": {
    "path": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    }
  }
}
```

This denies `.env`, `.env.local`, `.env.production`, and `src/.env`, but allows `.env.example`.
Bash commands like `cat .env`, `cp .env .env.backup`, and `echo secret > .env` (redirect targets) are all caught.

#### Composition with per-tool rules

A per-tool allow does not override a `path` deny — the path gate runs first.
Conversely, a per-tool deny still blocks even when the `path` surface allows:

```jsonc
{
  "permission": {
    "path": { "*": "allow" },
    "read": "deny"
  }
}
```

Here `read` calls pass the `path` gate but are blocked by the `read` tool gate.

### `external_directory` Surface

Controls access to paths outside the active working directory.
Use a pattern map to allow specific directories without opening all external access:

```jsonc
{
  "permission": {
    "external_directory": {
      "*": "ask",
      "~/development/*": "allow"
    }
  }
}
```

`external_directory` is evaluated before the normal tool permission check.
For example, `read: "allow"` can permit ordinary reads while `external_directory: "ask"` still requires confirmation before reading `../outside.txt` or an absolute path outside `ctx.cwd`.
Optional-path search tools (`find`, `grep`, `ls`) skip this check when no `path` is provided.

Bash commands are also covered: the extension extracts path-like tokens from the command string and applies the same gate when any resolve outside `ctx.cwd`.
Quoted strings are stripped first to reduce false positives.
This is a best-effort heuristic — variable expansion and escaped quotes are not parsed, and relative paths inside subshells are not yet resolved against a per-subshell working directory. (The separate `bash` command-pattern surface does evaluate commands nested inside substitutions and subshells; see that section.) OS device paths (`/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`) are always excluded.

#### Pi Infrastructure Read Auto-Allow

Read-only tools (`read`, `find`, `grep`, `ls`) targeting Pi infrastructure directories are automatically allowed without triggering the gate, even when `external_directory` is `ask` or `deny`.
Infrastructure directories include:

1. The agent config directory (`~/.pi/agent/` or `$PI_CODING_AGENT_DIR`)
2. Git-cloned global packages (`<agentDir>/git/`)
3. The global `node_modules` root (auto-discovered from the extension's own install path; falls back to `npm root -g` when running from a local development checkout)
4. Project-local Pi packages (`<cwd>/.pi/npm/` and `<cwd>/.pi/git/`)
5. Any paths listed in `piInfrastructureReadPaths`

Write tools (`write`, `edit`) to infrastructure paths are **not** auto-allowed and still go through the gate.

### Home Directory Expansion in Patterns

Pattern keys in any permission surface can start with `~/` or `$HOME/` (or be exactly `~` / `$HOME`).
They are expanded to the OS home directory at match time, so configs are portable across machines and users.

```jsonc
{
  "permission": {
    "external_directory": {
      "*": "ask",
      "~/development/*": "allow"
    }
  }
}
```

The pattern is stored and displayed as written (e.g. `~/development/*`) in logs and approval dialogs.

---

## Per-Agent Overrides

Override global permissions for specific agents via YAML frontmatter in Pi agent definition files.

### Global Agent Override

Path: `~/.pi/agent/agents/<agent>.md` (respects `PI_CODING_AGENT_DIR`)

```yaml
---
name: my-agent
permission:
  read: allow
  write: deny
  bash:
    git status: allow
    git *: ask
  mcp:
    "*": allow
    chrome_devtools_*: deny
    exa_*: allow
  skill:
    "*": ask
---
```

### Project Agent Override

Path: `<cwd>/.pi/agent/agents/<agent>.md`

Project agent files are resolved from Pi's current session `cwd`, so they are workspace-specific and do **not** move under `PI_CODING_AGENT_DIR`.

### Frontmatter Limitations

The frontmatter parser is intentionally minimal.
Use only `key: value` scalars and nested maps.
Avoid arrays, multi-line scalars, and YAML anchors.

---

## Common Recipes

### Protect Sensitive Files

```jsonc
{
  "permission": {
    "*": "ask",
    "read": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "write": {
      "*": "ask",
      "*.lock": "deny"
    }
  }
}
```

### Read-Only Mode

```jsonc
{
  "permission": {
    "*": "ask",
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "write": "deny",
    "edit": "deny"
  }
}
```

### Restricted Bash Surface

```jsonc
{
  "permission": {
    "*": "ask",
    "bash": {
      "*": "deny",
      "git status": "allow",
      "git diff": "allow",
      "git log *": "allow"
    }
  }
}
```

### MCP Discovery Only

```jsonc
{
  "permission": {
    "*": "ask",
    "mcp": {
      "*": "ask",
      "mcp_status": "allow",
      "mcp_list": "allow",
      "mcp_search": "allow",
      "mcp_describe": "allow"
    }
  }
}
```

### Per-Agent Lockdown

In the global Pi agents directory (default: `~/.pi/agent/agents/reviewer.md`, respects `PI_CODING_AGENT_DIR`):

```yaml
---
permission:
  write: deny
  edit: deny
  bash: deny
---
```

---

## Pi Integration Hooks

The extension integrates via Pi's lifecycle hooks:

| Hook                 | Behavior                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `before_agent_start` | Filters active tools, removes denied tool entries from the system prompt, and hides denied skills |
| `tool_call`          | Enforces permissions for every tool invocation                                                    |
| `input`              | Intercepts `/skill:<name>` requests and enforces skill policy                                     |

Additional behaviors:

- Unknown/unregistered tools are blocked before permission checks (prevents bypass attempts)
- The `Available tools:` system prompt section is rewritten to match the filtered active tool set
- Extension-provided tools like `task`, `mcp`, and third-party tools are handled by exact registered name
- Generic extension-tool approval prompts include a bounded input preview; built-in file tools use concise human-readable summaries
- Permission review logs include bounded `toolInputPreview` values for non-bash/non-MCP tool calls

---

## Schema Validation

Validate your config against the included schema:

```bash
npx --yes ajv-cli@5 validate \
  -s ./schemas/permissions.schema.json \
  -d ./config.json
```

**Editor tip:** Add `"$schema": "./schemas/permissions.schema.json"` to your config for autocomplete support.

## PreToolUse Hooks

The extension supports [Claude Code-compatible PreToolUse hooks](https://docs.anthropic.com/claude-code/settings).
Hooks run after the configured permission overrides (`allowLocalEdits`, `allowWebAccess`) and can `allow`, `deny`, `ask`, or `defer` a tool call.
They are sourced from the global scope only — per-project and per-agent hooks are not currently supported.

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/audit-bash.sh",
            "if": "Bash(rm -rf *)",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Matcher names use the **Claude Code** tool naming (`Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `LS`, `Skill`, `mcp__server__tool`), not the Pi tool names.
The `matcher` value is compiled as an anchored regex (`^(?:<matcher>)$`), so alternation (`Bash|Read`) works.

The optional `if` clause additionally filters by the tool's input field — e.g.
`Bash(rm -rf *)` matches when `input.command` matches `rm -rf *`,
`Edit(*/secret.ts)` matches when `input.file_path` (or `input.path`) matches `*/secret.ts`.
Wildcards use the same syntax as the rest of the permission system.

### Hook protocol

Each hook command receives a JSON object on stdin matching the Claude Code `PreToolUse` payload:

```jsonc
{
  "session_id": "…",
  "cwd": "…",
  "permission_mode": "default" /* or "yolo" */,
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "…" },
  "tool_use_id": "…",
  "transcript_path": "…"
}
```

The hook can respond by:

- printing JSON of shape `{ "hookSpecificOutput": { "permissionDecision": "allow" | "deny" | "ask" | "defer", "permissionDecisionReason": "…" } }` to stdout and exiting 0
- exiting with code `2` and writing a reason to stderr (treated as `deny`)
- any other exit (including non-zero exits, parse errors, timeouts) is treated as `defer` — the policy state is left unchanged

### Merging multiple hooks

When several hooks match a single call, their decisions merge with priority
`deny > ask > allow > defer`.
All non-empty reasons are concatenated into a single deny message.

### Limitations

Pi's tool-call hook surface only allows blocking with a reason.
If a hook returns `updatedInput` or `additionalContext`, these are logged as `hook.updated_input_not_supported` / `hook.additional_context_not_supported` to the debug log but **not** propagated to the agent runtime.
