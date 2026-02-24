import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  HookAgentDispatchPayload,
  HookPingDispatchPayload,
  HooksConfigResolved,
} from "../hooks.js";
import { createHooksRequestHandler } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

function buildTenantPingDefaultMessage(value: HookPingDispatchPayload): string {
  const domains = value.callback.allowedDomains ?? [];
  const domainsLine =
    domains.length > 0
      ? `Allowed tenant domains: ${domains.join(", ")}.`
      : "Allowed tenant domains: use only domains owned by this tenant.";

  return [
    `Process update ${value.update_id} for tenant ${value.tenant_id}.`,
    "All requests are tenant-business scoped.",
    "Read tenant-docs/.docs-base-url for the documentation base URL, then web_fetch that URL for the index and base URL + path for each doc.",
    "Never resolve docs under skills/tenant-api-ops/.",
    domainsLine,
    "If the docs URL fetch fails or the endpoint is undocumented, stop and report a status gap.",
    "Return concise output with action, endpoint, request summary, response status, and business result.",
  ].join(" ");
}

function classifyPolicyDecision(result: {
  status: "ok" | "error";
  summary: string;
  error?: string;
}): { decision: "allowed" | "blocked"; reason?: string } {
  const text = `${result.summary} ${result.error ?? ""}`.toLowerCase();
  if (
    text.includes("blocked") &&
    (text.includes("domain") || text.includes("allowlist") || text.includes("tenant policy"))
  ) {
    return {
      decision: "blocked",
      reason: result.error || result.summary,
    };
  }
  return { decision: "allowed" };
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = value.sessionKey.trim();
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.deliver,
        channel: value.channel,
        to: value.to,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
      },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
        });
        const summary = result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
        if (!result.delivered) {
          enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}` });
          }
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };

  const dispatchPingHook = (value: HookPingDispatchPayload) => {
    const sessionKey = value.sessionKey.trim();
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const message = value.message?.trim() || buildTenantPingDefaultMessage(value);
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: "PingHook",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message,
        model: value.model,
        thinking: value.thinking,
        deliver: false,
        channel: "last",
      },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      const finishedAt = new Date().toISOString();
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message,
          sessionKey,
          lane: "cron",
        });

        const summary = result.summary?.trim() || result.error?.trim() || result.status;
        await postPingCallback(value, {
          runId,
          status: result.status === "ok" ? "ok" : "error",
          summary,
          error: result.status === "ok" ? undefined : result.error || summary,
          sessionKey,
          finishedAt,
        });

        if (!result.delivered) {
          enqueueSystemEvent(`Ping ${value.update_id}: ${summary}`.trim(), {
            sessionKey: mainSessionKey,
          });
        }
      } catch (err) {
        const error = String(err);
        logHooks.warn(`hook ping failed: ${error}`);
        enqueueSystemEvent(`Ping ${value.update_id} (error): ${error}`, {
          sessionKey: mainSessionKey,
        });
        await postPingCallback(value, {
          runId,
          status: "error",
          summary: error,
          error,
          sessionKey,
          finishedAt,
        });
      }
    })();

    return runId;
  };

  async function postPingCallback(
    value: HookPingDispatchPayload,
    result: {
      runId: string;
      status: "ok" | "error";
      summary: string;
      error?: string;
      sessionKey: string;
      finishedAt: string;
    },
  ) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (value.callback.token) {
        headers.Authorization = `Bearer ${value.callback.token}`;
      }

      const response = await fetch(value.callback.url, {
        method: "POST",
        headers,
        body: JSON.stringify(
          (() => {
            const policy = classifyPolicyDecision(result);
            return {
              run_id: result.runId,
              update_id: value.update_id,
              tenant_id: value.tenant_id,
              callback_ref: value.callback_ref,
              status: result.status,
              summary: result.summary,
              error: result.error,
              session_key: result.sessionKey,
              finished_at: result.finishedAt,
              policy_decision: policy.decision,
              policy_reason: policy.reason,
            };
          })(),
        ),
      });
      if (!response.ok) {
        logHooks.warn(
          `hook ping callback failed for ${value.callback_ref}: status=${response.status}`,
        );
      }
    } catch (err) {
      logHooks.warn(`hook ping callback error for ${value.callback_ref}: ${String(err)}`);
    }
  }

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchPingHook,
    dispatchWakeHook,
  });
}
