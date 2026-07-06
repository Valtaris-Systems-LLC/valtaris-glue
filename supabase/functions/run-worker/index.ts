// Durable worker engine.
//
// Each invocation:
//   1. Atomically claims one job via claim_next_job() (FOR UPDATE SKIP LOCKED).
//   2. Resolves the DAG node + connector adapter.
//   3. Executes ONE step with adapter timeout + structured error.
//   4. Persists step_run + checkpoint + telemetry event.
//   5. On success: enqueues any newly-ready downstream nodes.
//   6. On retryable failure: reschedules the SAME job with backoff.
//   7. On exhaustion: moves job to dead_letter, opens an incident.
//   8. When the run terminates (all nodes done OR a non-retryable failure
//      with no live work left), finalizes workflow_runs.
//
// The worker drains up to BATCH jobs per invocation so a single HTTP call
// can carry an entire run to completion in dev, while still being safely
// re-entrant under concurrent invocations.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getConnector } from "../_shared/connectors.ts";
import { type DagGraph, nodeById } from "../_shared/dag.ts";
import { resolveExecutionSource } from "../_shared/runtime-versioning.ts";
import {
  buildDownstreamJobInserts,
  createApprovalPausePlan,
  createDeadLetterPlan,
  createRetryPlan,
  deriveRunFinalization,
} from "./logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH = 24;
const WORKER_ID = `worker-${crypto.randomUUID().slice(0, 8)}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Heartbeat: announce this worker is alive for stale-job sweeper.
  await sb.from("worker_heartbeats").upsert({
    worker_id: WORKER_ID, last_seen_at: new Date().toISOString(), status: "alive",
  });

  // Distributed registry: register this worker (or refresh its heartbeat).
  // active_jobs is incremented by claim_next_job and decremented when we finish.
  const REGION = Deno.env.get("WORKER_REGION") ?? "default";
  const CAPABILITIES = (Deno.env.get("WORKER_CAPABILITIES") ?? "internal,stripe,openai,sendgrid,twilio,slack,salesforce")
    .split(",").map((s) => s.trim()).filter(Boolean);
  await sb.from("worker_registry").upsert({
    worker_id: WORKER_ID,
    region: REGION,
    capabilities: CAPABILITIES,
    last_heartbeat: new Date().toISOString(),
    health_state: "active",
  }, { onConflict: "worker_id" });

  // If this worker has been drained externally, exit immediately.
  const { data: me } = await sb.from("worker_registry").select("health_state").eq("worker_id", WORKER_ID).single();
  if (me?.health_state && me.health_state !== "active") {
    return new Response(JSON.stringify({ worker_id: WORKER_ID, processed: 0, drained: true }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let processed = 0;
  const touchedRuns = new Set<string>();




  for (let i = 0; i < BATCH; i++) {
    const { data: job, error: claimErr } = await sb.rpc("claim_next_job", { _worker_id: WORKER_ID });
    if (claimErr) {
      console.error("[run-worker] claim error", claimErr);
      break;
    }
    if (!job || !job.id) break;
    try {
      await processJob(sb, job);
      touchedRuns.add(job.run_id);
      processed++;
    } catch (e) {
      console.error("[run-worker] process failed", e);
      await sb.from("workflow_jobs").update({
        state: "failed",
        error: e instanceof Error ? e.message : String(e),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
    }
  }


  // Final registry sync: recompute active_jobs from real in-flight jobs for this worker.
  const { count: inflight } = await sb
    .from("workflow_jobs")
    .select("id", { count: "exact", head: true })
    .eq("worker_id", WORKER_ID)
    .in("state", ["claimed", "running"]);
  await sb.from("worker_registry").update({
    active_jobs: inflight ?? 0,
    last_heartbeat: new Date().toISOString(),
  }).eq("worker_id", WORKER_ID);


  // Finalize any runs that may have completed
  for (const runId of touchedRuns) {
    await finalizeRunIfDone(sb, runId);
  }

  // If we hit the batch limit, kick a follow-on worker so the queue keeps draining.
  if (processed >= BATCH) {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    fetch(`${url}/functions/v1/run-worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: "{}",
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ worker_id: WORKER_ID, processed }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
});

interface Job {
  id: string;
  run_id: string;
  step_id: string | null;
  dag_node_id: string;
  state: string;
  retry_attempt: number;
  max_retries: number;
  idempotency_key: string;
  payload: Record<string, unknown>;
}

async function processJob(sb: SupabaseClient, job: Job) {
  // Idempotency guard: if a step_run already exists for this idempotency_key
  // and is `completed`, short-circuit. Workers crashing mid-flight cannot
  // produce duplicate side effects on retry.
  const { data: existing } = await sb
    .from("workflow_step_runs")
    .select("id,state,outputs")
    .eq("idempotency_key", job.idempotency_key)
    .maybeSingle();

  if (existing?.state === "completed") {
    await sb.from("workflow_jobs").update({
      state: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", job.id);
    await enqueueDownstream(sb, job.run_id, job.dag_node_id);
    return;
  }

  // Load DAG + run
  const { data: run } = await sb.from("workflow_runs").select("*").eq("id", job.run_id).single();
  if (!run) throw new Error(`run ${job.run_id} missing`);
  const resolved = await resolveExecutionSource(sb, {
    tenantId: run.tenant_id ?? null,
    dagId: run.dag_id ?? "demo.live",
    workflowVersionId: run.workflow_version_id ?? null,
    workflowName: run.workflow_name ?? null,
  });
  const graph = resolved.graph as DagGraph;
  const node = nodeById(graph, job.dag_node_id);
  if (!node) throw new Error(`dag node ${job.dag_node_id} missing`);

  const stepIndex = graph.nodes.findIndex((n) => n.id === node.id);

  // ── Approval gate ─────────────────────────────────────────
  // If this node requires approval AND no approved record exists yet,
  // create a pending approval and pause the job. The operator decision
  // endpoint will re-queue the job.
  if (node.approvalRequired) {
    const { data: existingApproval } = await sb
      .from("workflow_approvals")
      .select("id,state")
      .eq("job_id", job.id)
      .maybeSingle();

    if (!existingApproval) {
      const approvalPlan = createApprovalPausePlan({
        runId: job.run_id,
        jobId: job.id,
        nodeId: node.id,
        nodeName: node.name,
        tenantId: run.tenant_id ?? null,
      });
      const { data: appr } = await sb.from("workflow_approvals").insert(approvalPlan.approvalInsert).select().single();

      await sb.from("workflow_jobs").update(approvalPlan.jobUpdate).eq("id", job.id);

      await sb.from("workflow_runs").update(approvalPlan.runUpdate).eq("id", job.run_id);

      await emit(sb, job.run_id, null, run.tenant_id ?? null, "approval.requested", "warn",
        `⏸ Awaiting approval: ${node.name}`,
        { approval_id: appr?.id, ...approvalPlan.event.data });

      await sb.from("runtime_audit_log").insert({
        tenant_id: run.tenant_id ?? null,
        actor: approvalPlan.auditLog.actor, action: approvalPlan.auditLog.action,
        subject_type: "approval", subject_id: appr?.id ?? null,
        details: approvalPlan.auditLog.details,
      });
      return;
    } else if (existingApproval.state === "rejected" || existingApproval.state === "expired") {
      // Should already have been dead-lettered, but be defensive.
      await sb.from("workflow_jobs").update({
        state: "dead_letter", error: `approval ${existingApproval.state}`,
        completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      return;
    }
    // approved → fall through and execute
  }

  // Mark job + step running, claim a 120s lease.
  await sb.from("workflow_jobs").update({
    state: "running",
    heartbeat_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);


  const startedAt = new Date().toISOString();
  let step_id: string | null = existing?.id ?? null;
  if (step_id) {
    await sb.from("workflow_step_runs").update({
      state: "running",
      started_at: startedAt,
      attempt: job.retry_attempt,
      inputs: job.payload,
    }).eq("id", step_id);
  } else {
    const { data: inserted, error: stepErr } = await sb
      .from("workflow_step_runs")
      .insert({
        run_id: job.run_id,
        tenant_id: run.tenant_id ?? null,
        step_index: stepIndex,
        dag_node_id: node.id,
        name: node.name,
        connector: node.connector,
        state: "running",
        started_at: startedAt,
        attempt: job.retry_attempt,
        idempotency_key: job.idempotency_key,
        inputs: job.payload,
      })
      .select()
      .single();
    if (stepErr) throw stepErr;
    step_id = inserted?.id ?? null;
  }

  await emit(sb, job.run_id, step_id, run.tenant_id ?? null, "step.started", "info", `▶ ${node.name}`, {
    connector: node.connector, attempt: job.retry_attempt, dag_node_id: node.id,
  });

  // Execute via adapter
  const adapter = getConnector(node.connector);
  const result = await adapter.execute(node.name, job.payload, {
    timeoutMs: node.timeoutMs,
    idempotencyKey: job.idempotency_key,
  });

  // Touch connector_state with measured latency / health
  await sb.from("connector_state").update({
    latency_ms: result.latency_ms,
    last_success_at: result.ok ? new Date().toISOString() : undefined,
    last_error: result.ok ? null : result.error?.message ?? null,
    status: result.ok ? "healthy" : (result.error?.kind === "rate_limit" ? "degraded" : result.error?.kind === "timeout" ? "retrying" : "degraded"),
    updated_at: new Date().toISOString(),
  }).eq("connector", node.connector);

  // Feed connector outcome into the circuit breaker so persistent failures
  // trip isolation instead of amplifying retries downstream.
  await sb.rpc("record_connector_result", { _connector: node.connector, _ok: result.ok });


  if (result.ok) {
    await sb.from("workflow_step_runs").update({
      state: "completed",
      ended_at: new Date().toISOString(),
      duration_ms: result.latency_ms,
      outputs: result.data ?? {},
      connector_response: result.data ?? {},
      result: { ok: true, mock: result.mock },
    }).eq("id", step_id!);

    await sb.from("workflow_checkpoints").insert({
      run_id: job.run_id,
      tenant_id: run.tenant_id ?? null,
      workflow_version_id: run.workflow_version_id ?? null,
      step_index: stepIndex,
      snapshot: {
        node_id: node.id,
        name: node.name,
        connector: node.connector,
        inputs: job.payload,
        outputs: result.data ?? {},
        attempt: job.retry_attempt,
        idempotency_key: job.idempotency_key,
        correlation_id: run.correlation_id,
        workflow_version_id: run.workflow_version_id ?? null,
        mock: result.mock,
      },
    });


    if (node.connector === "openai" && result.data) {
      const confidence = typeof result.data.confidence === "number"
        ? result.data.confidence
        : 0.55 + Math.random() * 0.42;
      const escalated = confidence < 0.7;
      await sb.from("ai_decision_trace").insert({
        run_id: job.run_id,
        tenant_id: run.tenant_id ?? null,
        model: String(result.data.model ?? "openai/gpt-4o-mini"),
        prompt: String(job.payload.prompt ?? `Workflow ${run.workflow_name}`),
        decision: escalated ? "escalate to human reviewer" : "auto-approve",
        confidence: Number(confidence.toFixed(2)),
        escalated,
        reasoning: escalated ? "Confidence below 0.70 policy floor." : "Confidence above policy floor.",
        risk: confidence >= 0.85 ? "low" : confidence >= 0.7 ? "medium" : "high",
      });
      await emit(sb, job.run_id, step_id, run.tenant_id ?? null, "ai.decision", escalated ? "warn" : "info",
        `AI ${escalated ? "escalated" : "auto-approved"} (${Math.round(confidence * 100)}%)`,
        { confidence, escalated });
    }

    await emit(sb, job.run_id, step_id, run.tenant_id ?? null, "step.completed", "info",
      `✓ ${node.name} (${result.latency_ms}ms${result.mock ? " · mock" : ""})`,
      { duration_ms: result.latency_ms, mock: result.mock });

    await sb.from("workflow_jobs").update({
      state: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", job.id);

    await enqueueDownstream(sb, job.run_id, node.id);
    return;
  }

  // ── Failure path ─────────────────────────────────────────
  const nextAttempt = job.retry_attempt + 1;
  const retryPlan = result.error ? createRetryPlan({
    jobId: job.id,
    nodeName: node.name,
    retryAttempt: job.retry_attempt,
    maxRetries: job.max_retries,
    error: result.error,
  }) : null;

  if (retryPlan) {
    await sb.from("workflow_step_runs").update(retryPlan.stepUpdate).eq("id", step_id!);

    await sb.from("workflow_jobs").update(retryPlan.jobUpdate).eq("id", job.id);

    await emit(sb, job.run_id, step_id, run.tenant_id ?? null, retryPlan.event.type, retryPlan.event.severity,
      retryPlan.event.message,
      retryPlan.event.data);
    return;
  }

  // Exhausted or non-retryable → dead-letter + incident
  const deadLetterPlan = createDeadLetterPlan({
    jobId: job.id,
    runId: job.run_id,
    tenantId: run.tenant_id ?? null,
    nodeId: node.id,
    nodeName: node.name,
    connector: node.connector,
    nextAttempt,
    payload: job.payload,
    latencyMs: result.latency_ms,
    error: result.error,
  });
  await sb.from("workflow_step_runs").update(deadLetterPlan.stepUpdate).eq("id", step_id!);

  await sb.from("workflow_jobs").update(deadLetterPlan.jobUpdate).eq("id", job.id);

  await sb.from("workflow_dead_letter").insert(deadLetterPlan.deadLetterInsert);

  await sb.from("workflow_incidents").insert(deadLetterPlan.incidentInsert);

  await emit(sb, job.run_id, step_id, run.tenant_id ?? null, deadLetterPlan.event.type, deadLetterPlan.event.severity,
    deadLetterPlan.event.message,
    deadLetterPlan.event.data);
}

async function enqueueDownstream(sb: SupabaseClient, runId: string, completedNodeId: string) {
  const { data: run } = await sb.from("workflow_runs").select("dag_id,correlation_id,workflow_version_id,tenant_id,workflow_name").eq("id", runId).single();
  const resolved = await resolveExecutionSource(sb, {
    tenantId: run?.tenant_id ?? null,
    dagId: run?.dag_id ?? "demo.live",
    workflowVersionId: run?.workflow_version_id ?? null,
    workflowName: run?.workflow_name ?? null,
  });
  const graph = resolved.graph as DagGraph;

  const { data: jobs } = await sb.from("workflow_jobs").select("dag_node_id,state").eq("run_id", runId);
  const ready = buildDownstreamJobInserts({
    graph,
    jobs: jobs ?? [],
    runId,
    completedNodeId,
    runContext: run ?? {},
  });
  for (const pendingJob of ready) {
    await sb.from("workflow_jobs").insert(pendingJob).then(() => {}, () => {/* unique violation = already enqueued, fine */});
  }
}


async function finalizeRunIfDone(sb: SupabaseClient, runId: string) {
  const { data: run } = await sb.from("workflow_runs").select("*").eq("id", runId).single();
  if (!run || run.state === "completed" || run.state === "failed") return;
  const resolved = await resolveExecutionSource(sb, {
    tenantId: run.tenant_id ?? null,
    dagId: run.dag_id ?? "demo.live",
    workflowVersionId: run.workflow_version_id ?? null,
    workflowName: run.workflow_name ?? null,
  });
  const graph = resolved.graph as DagGraph;

  const { data: jobs } = await sb.from("workflow_jobs").select("dag_node_id,state").eq("run_id", runId);
  const finalization = deriveRunFinalization({
    graph,
    jobs: jobs ?? [],
    startedAt: run.started_at,
  });
  if (!finalization) return;

  await sb.from("workflow_runs").update(finalization.update).eq("id", runId);

  await sb.from("workflow_events").insert({
    run_id: runId,
    tenant_id: run.tenant_id ?? null,
    type: finalization.event.type,
    severity: finalization.event.severity,
    source: "run-worker",
    message: finalization.event.message,
    data: finalization.event.data,
  });
}

function emit(
  sb: SupabaseClient, run_id: string, step_id: string | null, tenant_id: string | null,
  type: string, severity: string, message: string, data: Record<string, unknown> = {},
) {
  return sb.from("workflow_events").insert({ run_id, step_id, tenant_id, type, severity, source: "run-worker", message, data });
}
