import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { warmBashParser } from "./access-intent/bash/parser";
import { buildResolvedIntentFromMatchValues } from "./access-intent/input-normalizer";
import { AuthorizerRegistry } from "./authority/authorizer-registry";
import { AuthorizerSelection } from "./authority/authorizer-selection";
import {
  ForwardedRequestServer,
  type ServingPolicy,
} from "./authority/forwarded-request-server";
import {
  ForwardingLivenessJudge,
  ServingHeartbeatStore,
} from "./authority/forwarding-liveness";
import { ForwardingManager } from "./authority/forwarding-manager";
import { SerialInteractivePromptQueue } from "./authority/interactive-prompt-queue";
import { PERMISSION_FORWARDING_TIMEOUT_MS } from "./authority/permission-forwarding";
import { requestPermissionDecision } from "./authority/permission-prompt-component";
import { PermissionPrompter } from "./authority/permission-prompter";
import {
  composeServingAnnouncers,
  getServingSessionRegistry,
} from "./authority/serving-registry";
import { SubagentDetection } from "./authority/subagent-detection";
import { subscribeSubagentLifecycle } from "./authority/subagent-lifecycle-events";
import { getSubagentSessionRegistry } from "./authority/subagent-registry";
import { registerBuiltinToolInputFormatters } from "./builtin-tool-input-formatters";
import { registerPermissionSystemCommand } from "./config-modal";
import { getGlobalConfigPath } from "./config-paths";
import { ConfigStore } from "./config-store";
import { DecisionAudit } from "./decision-audit";
import { GateDecisionReporter } from "./decision-reporter";
import { DialogFallbackPermissionResolver } from "./dialog-fallback-permission-resolver";
import { computeExtensionPaths } from "./extension-paths";
import {
  AgentPrepHandler,
  PermissionGateHandler,
  SessionLifecycleHandler,
} from "./handlers";
import { PreToolUseHookGate } from "./handlers/gates/pre-tool-use-hook-gate";
import { GateRunner } from "./handlers/gates/runner";
import {
  type ToolCallGateInputs,
  ToolCallGatePipeline,
} from "./handlers/gates/tool-call-gate-pipeline";
import { createFailClosedToolCall } from "./handlers/tool-call-boundary";
import { pathFlavorForPlatform } from "./path/path-flavor";
import { PermissionManager } from "./permission-manager";
import { PermissionResolver } from "./permission-resolver";
import { PermissionSession } from "./permission-session";
import { LocalPermissionsService } from "./permissions-service";
import { resolveRenderBudget } from "./presentation/dialog-renderer";
import { PermissionServiceLifecycle } from "./service-lifecycle";
import { PermissionSessionLogger } from "./session-logger";
import { SessionRules } from "./session-rules";
import { ToolAccessExtractorRegistry } from "./tool-access-extractor-registry";
import { ToolInputFormatterRegistry } from "./tool-input-formatter-registry";

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  // getPackageDir() is Pi's own install dir; auto-allow it for read-only tools
  // so the agent can read Pi's bundled docs/examples regardless of layout.
  const paths = computeExtensionPaths(agentDir, getPackageDir());
  // The composition root owns process.platform reads and injects their
  // products. This path-language flavor is shared by the session's
  // PathNormalizer, rule evaluation, and subagent detection. Interior modules
  // must not read process.platform (enforced by the eslint guard scoped to
  // src/) or re-derive platform behavior.
  const hostFlavor = pathFlavorForPlatform(process.platform);
  const sessionRules = new SessionRules();
  const subagentRegistry = getSubagentSessionRegistry();
  // Process-global, like subagentRegistry: an in-process child reads it from a
  // separate jiti instance to learn whether its parent is draining its inbox.
  const servingRegistry = getServingSessionRegistry();
  // Single owner of subagent detection, shared across every consumer instead of
  // threading the (subagentSessionsDir, platform, registry) triple into each.
  const subagentDetection = new SubagentDetection({
    subagentSessionsDir: paths.subagentSessionsDir,
    flavor: hostFlavor,
    registry: subagentRegistry,
  });
  const formatterRegistry = new ToolInputFormatterRegistry();
  registerBuiltinToolInputFormatters(formatterRegistry);
  const accessExtractorRegistry = new ToolAccessExtractorRegistry();
  // One registry instance backs both the registerAuthorizer service surface and
  // AuthorizerSelection's chain resolution, so a registration is visible to
  // composition.
  const authorizerRegistry = new AuthorizerRegistry();

  // Both `configStore` and `session` are forward-declared so the logger's
  // lazy thunks can close over them without a cast or null-init holder.
  // TypeScript exempts closure captures from definite-assignment analysis;
  // all synchronous reads occur after the assignments below.
  // eslint-disable-next-line prefer-const -- forward-declared let; `const` requires an initializer
  let configStore: ConfigStore;
  // eslint-disable-next-line prefer-const -- forward-declared let; `const` requires an initializer
  let session: PermissionSession;

  const permissionManager = new PermissionManager({
    agentDir,
    flavor: hostFlavor,
  });

  const logger = new PermissionSessionLogger({
    globalLogsDir: paths.globalLogsDir,
    getConfig: () => configStore.current(),
    notify: (message) => session.notify(message),
  });

  configStore = new ConfigStore({
    agentDir,
    policyPaths: permissionManager,
    logger,
  });

  const prompter = new PermissionPrompter({ logger });
  const promptQueue = new SerialInteractivePromptQueue();

  // The filesystem half of the serving announcement. `servingRegistry` reaches
  // an in-process child through `globalThis`; a child in its own process shares
  // nothing but this directory, so the served session publishes a heartbeat
  // there too (#721).
  const servingHeartbeats = new ServingHeartbeatStore({
    forwardingDir: paths.forwardingDir,
    logger,
  });
  // The read side of both channels, routed by how the target was resolved.
  const servingLiveness = new ForwardingLivenessJudge({
    registry: servingRegistry,
    heartbeats: servingHeartbeats,
  });

  const authorizerSelection = new AuthorizerSelection({
    detection: subagentDetection,
    events: pi.events,
    getPromptPreferences: () => ({
      doublePressToConfirm: configStore.current().doublePressToConfirm,
      budget: resolveRenderBudget(configStore.current()),
    }),
    promptQueue,
    requestPermissionDecision,
    forwardingDir: paths.forwardingDir,
    registry: subagentRegistry,
    serving: servingLiveness,
    getForwardingTimeoutMs: () =>
      configStore.current().forwardingTimeoutMs ??
      PERMISSION_FORWARDING_TIMEOUT_MS,
    logger,
    prompter,
    // The published service is the narrow, session-scoped PermissionQuery a
    // chain link is handed (it routes bash/path at gate parity against the live
    // session cwd). A thunk because `permissionsService` is constructed below;
    // it resolves at session_start (activate), well after assignment.
    getPermissionQuery: () => permissionsService,
    // Retained for service compatibility; no registered link is activated in
    // the hooks-first runtime.
    authorizerRegistry,
    getAuthorizerChain: () => [],
  });

  // The retained resolver still owns access-path normalization and session
  // rule composition. Production consumers use the dialog adapter so only a
  // user session grant can resolve without a prompt.
  const policyResolver = new PermissionResolver(
    permissionManager,
    sessionRules,
  );
  const dialogResolver = new DialogFallbackPermissionResolver(policyResolver);

  // Preserve the child-fixed access facts while forcing non-session outcomes
  // to the serving node's dialog. Match values are never re-derived through
  // this session's PathNormalizer/cwd (#597).
  const servingPolicy: ServingPolicy = {
    resolve: (intent) =>
      dialogResolver.resolve(
        buildResolvedIntentFromMatchValues(
          intent.surface,
          intent.matchValues,
          intent.principal.agentName,
        ),
      ),
  };

  // Constructed here rather than beside the gate runner below: the serving
  // side broadcasts its own decisions, so both readers share one reporter over
  // this session's event bus.
  const reporter = new GateDecisionReporter(logger, pi.events);

  const requestServer = new ForwardedRequestServer({
    forwardingDir: paths.forwardingDir,
    logger,
    policy: servingPolicy,
    escalator: authorizerSelection,
    // The forwarded ask's own gate lives in the requesting session, so the
    // serving side announces the terminal decision on this session's bus.
    broadcaster: reporter,
    // Records a whole-session grant into the same SessionRules the resolver and
    // gate runner read, so a serving-scope grant governs the parent and future
    // forwarded resolutions.
    recorder: sessionRules,
    registry: subagentRegistry,
  });

  session = new PermissionSession(
    paths,
    new ForwardingManager({
      detection: subagentDetection,
      forwarder: requestServer,
      serving: composeServingAnnouncers(servingRegistry, servingHeartbeats),
      logger,
    }),
    permissionManager,
    sessionRules,
    configStore,
    authorizerSelection,
    hostFlavor,
  );

  // refresh() must run after `session` is assigned: a debug-write IO failure
  // triggers the logger's notify sink — `session.notify(m)` — which no-ops
  // on the null context but requires `session` to be bound.
  // No ctx/trust decision exists at factory init, so withhold the project
  // scope (fail closed); session_start reloads with the real trust decision.
  configStore.refresh(undefined, false);

  const configPath = getGlobalConfigPath(agentDir);
  registerPermissionSystemCommand(pi, {
    config: configStore,
    configPath,
    getActiveAgentConfigRules: () =>
      permissionManager.getComposedConfigRules(
        session.lastKnownActiveAgentName ?? undefined,
      ),
  });

  const permissionsService = new LocalPermissionsService(
    dialogResolver,
    session,
    formatterRegistry,
    accessExtractorRegistry,
    authorizerRegistry,
  );

  // Subscribe to @gotgenes/pi-subagents' child lifecycle events so child
  // sessions register/unregister without the core calling us (ADR 0002).
  const unsubSubagentLifecycle = subscribeSubagentLifecycle(
    pi.events,
    subagentRegistry,
  );

  // PermissionServiceLifecycle owns the process-global service publication:
  // activate() publishes (skipped for registered subagent children — see #302)
  // and emits ready; teardown() unsubscribes all session listeners and
  // unpublishes. Deferred to session_start because identifying a child
  // requires the session id from ctx, unavailable at factory-init time.
  const serviceLifecycle = new PermissionServiceLifecycle(
    permissionsService,
    subagentDetection,
    pi.events,
    [unsubSubagentLifecycle],
  );

  const toolRegistry = {
    getAll: () => pi.getAllTools(),
    getActive: () => pi.getActiveTools(),
    setActive: (names: string[]) => pi.setActiveTools(names),
  };

  const audit = new DecisionAudit();
  const lifecycle = new SessionLifecycleHandler(
    session,
    policyResolver,
    serviceLifecycle,
    logger,
    audit,
  );
  const agentPrep = new AgentPrepHandler(
    session,
    dialogResolver,
    toolRegistry,
    () => {
      void warmBashParser();
    },
  );

  const gateRunner = new GateRunner(
    dialogResolver,
    sessionRules,
    authorizerSelection,
    reporter,
    () => false,
  );
  const dialogToolCallInputs: ToolCallGateInputs = {
    getActiveSkillEntries: () => session.getActiveSkillEntries(),
    getInfrastructureReadDirs: () => session.getInfrastructureReadDirs(),
    getToolPreviewLimits: () => session.getToolPreviewLimits(),
    getPathNormalizer: () => session.getPathNormalizer(),
    // Shell aliases remain implemented upstream but are intentionally dormant
    // in the hooks-first runtime.
    getShellToolAliases: () => undefined,
  };
  const toolCallGatePipeline = new ToolCallGatePipeline(
    dialogResolver,
    dialogToolCallInputs,
    formatterRegistry,
    accessExtractorRegistry,
    "dialog-fallback",
  );
  const preToolUseHooks = new PreToolUseHookGate(
    () => configStore.current(),
    reporter,
    process.platform !== "win32",
  );
  const gates = new PermissionGateHandler(
    session,
    toolRegistry,
    toolCallGatePipeline,
    gateRunner,
    preToolUseHooks,
  );

  pi.on("session_start", (event, ctx) =>
    lifecycle.handleSessionStart(event, ctx),
  );
  pi.on("resources_discover", (event, ctx) =>
    lifecycle.handleResourcesDiscover(event, ctx),
  );
  pi.on("session_shutdown", () => lifecycle.handleSessionShutdown());
  pi.on("before_agent_start", (event, ctx) => agentPrep.handle(event, ctx));
  pi.on(
    "tool_call",
    createFailClosedToolCall(
      (event, ctx) => gates.handleToolCall(event, ctx),
      reporter,
      audit,
      logger,
    ),
  );
}
