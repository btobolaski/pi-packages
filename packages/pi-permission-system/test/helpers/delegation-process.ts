import { spawn } from "node:child_process";
import { on, once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ParentAuthorizer } from "#src/authority/approval-escalator";
import { DelegationControlClient } from "#src/authority/delegation-control";
import type { ForwarderContext } from "#src/authority/forwarder-context";
import {
  ForwardingLivenessJudge,
  ServingHeartbeatStore,
} from "#src/authority/forwarding-liveness";
import {
  type DelegationIdentity,
  PermissionDelegation,
} from "#src/authority/permission-delegation";
import { ServingSessionRegistry } from "#src/authority/serving-registry";
import type { GateDescriptor } from "#src/handlers/gates/descriptor";
import { GateRunner } from "#src/handlers/gates/runner";
import { SessionApproval } from "#src/session-approval";
import type { DebugReviewLogger } from "#src/session-logger";
import { SessionRules } from "#src/session-rules";

export interface DelegationProcessConfig {
  forwardingDir: string;
  identity: DelegationIdentity;
  gate: Omit<GateDescriptor, "sessionApproval">;
}

/**
 * Launch the real child with bounded shutdown and ordered IPC barriers.
 * Captured stderr is the only diagnostic output when IPC stops; retained for the 15-second child lifetime without a size cap.
 */
export function startDelegationProcess(config: DelegationProcessConfig) {
  const fixturePath = fileURLToPath(import.meta.url);
  const src = fileURLToPath(new URL("../../src", import.meta.url));
  // Reuse the SDK's installed TypeScript loader without adding a dependency or writing a loader file.
  const bootstrap = `
    const { createRequire } = require("node:module");
    const { createJiti } = createRequire(${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))})("jiti");
    const jiti = createJiti(${JSON.stringify(fixturePath)}, { fsCache: false, alias: { "#src": ${JSON.stringify(src)} } });
    jiti.import(${JSON.stringify(fixturePath)}).then(m => m.run(JSON.parse(process.argv[1])))
      .catch(error => { console.error(error); process.exit(1); });
  `;
  const child = spawn(
    process.execPath,
    ["-e", bootstrap, JSON.stringify(config)],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  const messages = on(child, "message", { close: ["close"] });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  return {
    child,
    closed,
    get stderr() {
      return stderr;
    },
    async receive(kind: string) {
      const next = await messages.next();
      if (next.done) throw new Error(`Child exited before ${kind}: ${stderr}`);
      const message = next.value[0] as Record<string, unknown>;
      if (message.kind !== kind)
        throw new Error(
          `Expected ${kind}, received ${JSON.stringify(message)}: ${stderr}`,
        );
      return message;
    },
    async dispose() {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
      await messages.return?.();
    },
  };
}

/** IPC only schedules the test; all permission traffic uses the real filesystem protocol. */
export async function run({
  forwardingDir,
  identity,
  gate,
}: DelegationProcessConfig): Promise<void> {
  let waits = 0;
  const logger: DebugReviewLogger = {
    debug() {},
    review(event, details) {
      if (event === "forwarded_permission.request_created") {
        process.send?.({
          kind: "request",
          requestId: details?.requestId,
          waits,
        });
      }
    },
  };
  const context: ForwarderContext = {
    hasUI: true,
    cwd: identity.childCwd,
    ui: {
      select: () => {
        throw new Error("Child UI must not be used");
      },
      input: () => {
        throw new Error("Child UI must not be used");
      },
    },
    sessionManager: {
      getSessionId: () => identity.childSessionId,
      getSessionDir: () => forwardingDir,
      getEntries: () => [],
    },
  };
  const heartbeats = new ServingHeartbeatStore({ forwardingDir, logger });
  const client = new DelegationControlClient({
    forwardingDir,
    logger,
    heartbeats,
    timeoutMs: () => 10000,
  });
  const delegation = new PermissionDelegation(
    { getContext: () => context, canonicalizeCwd: (value) => value },
    client,
    true,
  );
  delegation.subscribeWaits((pending) => {
    waits = pending.length;
  });
  const connecting = delegation.connect(identity);
  await Promise.resolve(); // Let the lower client publish its handshake before telling the parent to process it.
  process.send?.({ kind: "connecting" });
  const ready = await connecting;
  const binding = delegation.getBinding();
  if (!binding) throw new Error("Ready connection has no binding");
  const begin = once(process, "message");
  process.send?.({ kind: "ready", ...ready, pid: process.pid });
  await begin;

  const authorizer = new ParentAuthorizer(context, {
    forwardingDir,
    logger,
    delegation: binding,
    getTimeoutMs: () => 10000,
    serving: new ForwardingLivenessJudge({
      registry: new ServingSessionRegistry(),
      heartbeats,
    }),
  });
  const childRules = new SessionRules();
  const runner = new GateRunner(
    {
      resolve: () => ({
        state: "ask",
        toolName: gate.surface,
        source: "tool",
        origin: "builtin",
      }),
    },
    childRules,
    { escalate: (details) => authorizer.authorize(details) },
    { writeReviewLog() {}, emitDecision() {} },
    () => false,
  );
  const requestController = new AbortController();
  const signal = AbortSignal.any([requestController.signal, binding.signal]);
  const intervention = once(process, "message");
  const permission = runner.run(
    { ...gate, sessionApproval: SessionApproval.single(gate.surface, "git *") },
    identity.agentName,
    {
      signal,
      isActive: () => !signal.aborted && binding.isLive(),
    },
  );
  const [command] = await intervention;
  if (command === "cancel") requestController.abort();
  else if (command === "observe-loss") {
    if (client.isBindingLive(ready.delegationId))
      throw new Error("Expected an observed binding loss");
  } else throw new Error("Unexpected process-test intervention");
  const outcome = await permission;
  if (outcome.action === "allow")
    writeFileSync(join(forwardingDir, "executed"), "executed");
  const finish = once(process, "message");
  process.send?.({
    kind: "settled",
    outcome,
    childGrants: childRules.getRuleset(),
    waits,
    bindingLive: client.isBindingLive(ready.delegationId),
    bindingAvailable: client.getBindingSignal(ready.delegationId) !== undefined,
    bindingAborted: binding.signal.aborted,
  });
  await finish;
  // On loss, natural process exit (without close()) proves the heartbeat interval was disposed.
  if (command === "cancel") delegation.close();
  process.disconnect();
}
