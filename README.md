# pi-packages

A monorepo of [Pi](https://github.com/badlogic/pi-mono) extension packages published to npm under `@gotgenes/`.
Some packages are designed for broad use; others scratch a personal itch and are shared in case they help others.

## Packages

| Package                                                                      | Description                                                                | Downloads/month                                                                                                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [@gotgenes/pi-permission-system](./packages/pi-permission-system/)           | Hooks-first tool authorization with serialized fallback dialogs            | [![npm](https://img.shields.io/npm/dm/@gotgenes/pi-permission-system)](https://www.npmjs.com/package/@gotgenes/pi-permission-system)           |
| [@gotgenes/pi-permission-model-judge](./packages/pi-permission-model-judge/) | Authorizer-chain compatibility package; dormant in the hooks-first runtime | [![npm](https://img.shields.io/npm/dm/@gotgenes/pi-permission-model-judge)](https://www.npmjs.com/package/@gotgenes/pi-permission-model-judge) |
| [@gotgenes/pi-subagents](./packages/pi-subagents/)                           | Focused, in-process autonomous sub-agent core for Pi                       | [![npm](https://img.shields.io/npm/dm/@gotgenes/pi-subagents)](https://www.npmjs.com/package/@gotgenes/pi-subagents)                           |
| [@gotgenes/pi-github-tools](./packages/pi-github-tools/)                     | Deterministic GitHub CI, release, and issue tools                          | [![npm](https://img.shields.io/npm/dm/@gotgenes/pi-github-tools)](https://www.npmjs.com/package/@gotgenes/pi-github-tools)                     |
| [@gotgenes/pi-autoformat](./packages/pi-autoformat/)                         | Prompt-end auto-formatting with Biome, Prettier, and related tools         | [![npm](https://img.shields.io/npm/dm/@gotgenes/pi-autoformat)](https://www.npmjs.com/package/@gotgenes/pi-autoformat)                         |
| [@gotgenes/pi-colgrep](./packages/pi-colgrep/)                               | Semantic code search through ColGrep                                       | [![npm](https://img.shields.io/npm/dm/@gotgenes/pi-colgrep)](https://www.npmjs.com/package/@gotgenes/pi-colgrep)                               |
| [@gotgenes/pi-session-tools](./packages/pi-session-tools/)                   | Session naming and context bridges for multi-session workflows             | [![npm](https://img.shields.io/npm/dm/@gotgenes/pi-session-tools)](https://www.npmjs.com/package/@gotgenes/pi-session-tools)                   |
| [@gotgenes/pi-subagents-worktrees](./packages/pi-subagents-worktrees/)       | Git worktree isolation provider for pi-subagents                           | [![npm](https://img.shields.io/npm/dm/@gotgenes/pi-subagents-worktrees)](https://www.npmjs.com/package/@gotgenes/pi-subagents-worktrees)       |
| [@gotgenes/pi-nocd](./packages/pi-nocd/)                                     | System-prompt guard against unnecessary working-directory changes          | [![npm](https://img.shields.io/npm/dm/@gotgenes/pi-nocd)](https://www.npmjs.com/package/@gotgenes/pi-nocd)                                     |

Each package README contains its setup, usage, and configuration reference.

## Install

Install the repository checkout as one Pi package:

```bash
pi install git:github.com/gotgenes/pi-packages
```

Install one published package:

```bash
pi install npm:@gotgenes/<package-name>
```

The root `package.json` directly exposes `packages/pi-permission-system/src/index.ts` when the repository is loaded from git.

## Uninstall

Remove a git installation:

```bash
pi remove git:github.com/gotgenes/pi-packages
```

Remove an npm installation:

```bash
pi remove npm:@gotgenes/<package-name>
```

## Development

### Prerequisites

- Node.js 22 or newer.
- [pnpm](https://pnpm.io/) 11.

### Setup

```bash
pnpm install
```

The prepare script installs `prek` hooks when the executable is available.
Commit messages use Conventional Commits.

### Commands

```bash
pnpm run check
pnpm run test
pnpm run lint
pnpm run lint:fix
pnpm fallow dead-code
```

Run package-specific commands from the repository root:

```bash
pnpm --filter @gotgenes/pi-permission-system run test
pnpm --filter @gotgenes/pi-subagents run check
```

### Reviewing Changes by Package

`scripts/hunk-pkg-diff.sh <package-name> [hunk-options...]` compares one package with its latest `<component>-v<version>` release tag through [Hunk](https://github.com/modem-dev/hunk).

```bash
scripts/hunk-pkg-diff.sh pi-subagents
scripts/hunk-pkg-diff.sh pi-permission-system --mode split
```

An equivalent [Diffview.nvim](https://github.com/sindrets/diffview.nvim) command is available through `.nvim.lua`:

```vim
:PkgDiffview pi-subagents
:PkgDiffview pi-permission-system
```

### Local Pi Configuration

This repository intentionally ships no `.pi/` directory, trusted Pi settings, prompt templates, agents, or skills.
Use your own reviewed global Pi configuration when developing in this checkout.
Package-specific engineering context lives in each package's `README.md` and `AGENTS.md` when present.

## License

MIT
