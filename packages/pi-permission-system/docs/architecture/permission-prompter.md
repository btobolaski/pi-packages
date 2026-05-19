# PermissionPrompter

`src/permission-prompter.ts`

## Responsibility

`PermissionPrompter` owns the full permission-prompt flow for a single agent request.
It exposes two entry points — the standard `prompt()` used by every descriptor-based gate, and the specialised `promptWebAccess()` used by the per-domain `fetch_content` dialog.

### `prompt()` flow

1. **Yolo-mode check** — if `yoloMode` is enabled in the active config, auto-approve and write a `permission_request.auto_approved` review-log entry without showing any UI.
2. **Review log — waiting** — write `permission_request.waiting` before any dialog is shown.
3. **UI/forwarding branch** — delegate to `confirmPermission()` in `forwarded-permissions/polling.ts`, which selects the correct path:
   - `ctx.hasUI` → show the interactive dialog via `requestPermissionDecisionFromUi`.
   - subagent context → write a forwarded-permission request file and poll for the parent session's response.
   - neither → deny immediately.
4. **Review log — outcome** — write `permission_request.approved` or `permission_request.denied` with the final decision state and any denial reason.

### `promptWebAccess()` flow

The per-domain `fetch_content` dialog uses a different option set (`Yes / Yes, always allow <domain> / Yes, allow <domain> for this session / No / No, provide reason`) and only runs when the call has a UI available, so the flow is simpler:

1. **Yolo-mode check** — same as `prompt()`.
2. **Review log — waiting** — same as `prompt()`.
3. **UI dialog** — directly invoke `requestWebAccessPermissionFromUi(ui, title, message, domain)`.
   There is no `confirmPermission` step and no forwarding fallback: callers must guard with `ctx.hasUI` themselves (`PermissionGateHandler.runFetchContentDialogIfNeeded`).
4. **Review log — outcome** — same `permission_request.approved` / `permission_request.denied` entries as `prompt()`.
   The handler that called `promptWebAccess()` adds the domain-persistence and decision-event review log entries on top.

## Why a class instead of a free function

The previous implementation was `promptPermission(runtime, forwardingDeps, ctx, details)` in `runtime.ts`.
Adding a new field to `PromptPermissionDetails` (e.g. `sessionLabel` in #51) required touching four files: `types.ts` → `runtime.ts` → `polling.ts` → `index.ts`.

With `PermissionPrompter`, adding a new field touches a single file:

- `src/permission-prompter.ts` — add the field to `PromptPermissionDetails` and read it inside `prompt()` / `promptWebAccess()`.

Handler code and wiring in `index.ts` are unaffected.

## Interfaces

```typescript
interface PermissionPrompterApi {
  prompt(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
  promptWebAccess(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
    domain: string,
  ): Promise<WebAccessPermissionDecision>;
}

interface PermissionPrompterDeps {
  getConfig(): PermissionSystemExtensionConfig;  // yolo-mode check
  writeReviewLog(event: string, details: Record<string, unknown>): void;
  subagentSessionsDir: string;                   // forwarding path detection
  forwardingDir: string;                         // forwarded-request files
  requestPermissionDecisionFromUi(...): Promise<PermissionPromptDecision>;
  requestWebAccessPermissionFromUi(
    ui, title, message, domain,
  ): Promise<WebAccessPermissionDecision>;
}
```

`PromptPermissionDetails`, `PermissionPrompterApi`, and `PermissionPrompterDeps` are all exported from `src/permission-prompter.ts`.

## Relationship to PermissionForwardingDeps

`PermissionPrompter` constructs a `PermissionForwardingDeps` internally when calling `confirmPermission()`.
The `shouldAutoApprove` field in that internal object always returns `false` — yolo-mode is already handled at the prompter level before `confirmPermission` is ever reached.

The separate `forwardingDeps` object in `index.ts` (used by `startForwardedPermissionPolling`) is independent: it carries its own `shouldAutoApprove` for the parent-session flow that processes requests forwarded from subagents.

## Wiring

`PermissionPrompter` is instantiated once in `piPermissionSystemExtension()` (`src/index.ts`) and both entry points are injected into `PermissionSessionRuntimeDeps`:

```typescript
const prompter = new PermissionPrompter({ … });
// …
promptPermission: (ctx, details) => prompter.prompt(ctx, details),
promptWebAccessPermission: (ctx, details, domain) =>
  prompter.promptWebAccess(ctx, details, domain),
```

Handler classes call `session.prompt(ctx, details)` or `session.promptWebAccess(ctx, details, domain)`, which delegate to the injected prompter.
Tests mock `prompt` and `promptWebAccess` on the `PermissionSession` mock directly.
