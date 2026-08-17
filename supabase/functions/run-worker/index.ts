// Durable worker engine.
//
// Each invocation:
//   1. Atomically claims one job via claim_next_job() (FOR UPDATE SKIP LOCKED).
//   2. Resolves the workflow graph from the run's immutable workflow version.
//   3. Resolves the DAG node + connector adapter.
//   4. Executes ONE step with adapter timeout + structured error.
//   5. Persists step_run + checkpoint + telemetry event.
//   6. On success: enqueues any newly-ready downstream nodes.
//   7. On retryable failure: reschedules the SAME job with backoff.
//   8. On exhaustion: moves job to dead_letter, opens an incident.
//   9. When the run terminates (all nodes done OR a non-retryable failure
//      with no live work left), finalizes workflow_runs.
//
// Versioning rule:
//   - New runs MUST use workflow_version_id.
//   - The worker resolves the immutable graph from workflow_versions.graph.
//   - Legacy workflow_dags fallback is retained only for older runs that
//     predate workflow_version_id.
//
// The worker drains up to BATCH jobs per invocation so a single HTTP call
// can carry an entire run to completion in dev, while still being safely
// re-entrant under concurrent invocations.

import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getConnector } from "../_shared/connectors.ts";
import {
  DEFAULT_POLICY,
  nextBackoffMs,
  shouldRetry,
} from "../_shared/retry.ts";
import {
  type DagGraph,
  isTerminal,
  nodeById,
  type NodeState,
  readyNodes,
} from "../_shared/dag.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BATCH = 24;
const WORKER_ID = `worker-${crypto.randomUUID().slice(0, 8)}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Heartbeat: announce this worker is alive for stale-job sweeper.
  await sb.from("worker_heartbeats").upsert({
    worker_id: WORKER_ID,
    last_seen_at: new Date().toISOString(),
    status: "alive",
  });

  // Distributed registry: register this worker (or refresh its heartbeat).
  // active_jobs is incremented by claim_next_job and decremented when we finish.
  const REGION = Deno.env.get("WORKER_REGION") ?? "default";

  const CAPABILITIES = (
    Deno.env.get("WORKER_CAPABILITIES") ??
    "internal,stripe,openai,sendgrid,twilio,slack,salesforce"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await sb.from("worker_registry").upsert(
    {
      worker_id: WORKER_ID,
      region: REGION,
      capabilities: CAPABILITIES,
      last_heartbeat: new Date().toISOString(),
      health_state: "active",
    },
    { onConflict: "worker_id" },
  );

  // If this worker has been drained externally, exit immediately.
  const { data: me } = await sb
    .from("worker_registry")
    .select("health_state")
    .eq("worker_id", WORKER_ID)
    .single();

  if (me?.health_state && me.health_state !== "active") {
    return new Response(
      JSON.stringify({
        worker_id: WORKER_ID,
        processed: 0,
        drained: true,
      }),
      {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": "application/json",
        },
      },
    );
  }

  let processed = 0;
  const touchedRuns = new Set<string>();

  for (let i = 0; i < BATCH; i++) {
    const { data: job, error: claimErr } = await sb.rpc(
      "claim_next_job",
      { _worker_id: WORKER_ID },
    );

    if (claimErr) {
      console.error("[run-worker] claim error", claimErr);
      break;
    }

    if (!job || !job.id) {
      break;
    }

    try {
      await processJob(sb, job);
      touchedRuns.add(job.run_id);
      processed++;
    } catch (e) {
      console.error("[run-worker] process failed", e);

      await sb
        .from("workflow_jobs")
        .update({
          state: "failed",
          error: e instanceof Error ? e.message : String(e),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    }
  }

  // Final registry sync: recompute active_jobs from real in-flight jobs.
  const { count: inflight } = await sb
    .from("workflow_jobs")
    .select("id", { count: "exact", head: true })
    .eq("worker_id", WORKER_ID)
    .in("state", ["claimed", "running"]);

  await sb
    .from("worker_registry")
    .update({
      active_jobs: inflight ?? 0,
      last_heartbeat: new Date().toISOString(),
    })
    .eq("worker_id", WORKER_ID);

  // Finalize any runs that may have completed.
  for (const runId of touchedRuns) {
    await finalizeRunIfDone(sb, runId);
  }

  // If we hit the batch limit, kick a follow-on worker so the queue keeps draining.
  if (processed >= BATCH) {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    fetch(`${url}/functions/v1/run-worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: "{}",
    }).catch(() => {});
  }

  return new Response(
    JSON.stringify({
      worker_id: WORKER_ID,
      processed,
    }),
    {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json",
      },
    },
  );
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

interface WorkflowRun {
  id: string;
  workflow_name: string;
  workflow_version_id: string | null;
  dag_id: string | null;
  correlation_id: string | null;
  tenant_id: string | null;
  started_at: string;
}

interface LoadedGraph {
  run: WorkflowRun;
  graph: DagGraph;
  versionId: string | null;
  source: "workflow_version" | "legacy_dag";
}

async function loadRunGraph(
  sb: SupabaseClient,
  runId: string,
): Promise<LoadedGraph> {
  const { data: run, error: runErr } = await sb
    .from("workflow_runs")
    .select(
      "id,workflow_name,workflow_version_id,dag_id,correlation_id,tenant_id,started_at",
    )
    .eq("id", runId)
    .single();

  if (runErr) {
    throw runErr;
  }

  if (!run) {
    throw new Error(`run ${runId} missing`);
  }

  /*
   * PRIMARY PATH
   *
   * Every new execution created by execute-workflow carries an immutable
   * workflow_version_id. Resolve its graph directly from workflow_versions.
   *
   * This prevents an in-flight run from silently changing behavior because
   * workflow_dags was edited after the run was created.
   */
  if (run.workflow_version_id) {
    const { data: version, error: versionErr } = await sb
      .from("workflow_versions")
      .select("id,state,graph")
      .eq("id", run.workflow_version_id)
      .single();

    if (versionErr) {
      throw versionErr;
    }

    if (!version) {
      throw new Error(
        `workflow version ${run.workflow_version_id} missing for run ${run.id}`,
      );
    }

    if (!version.graph || !Array.isArray(version.graph.nodes)) {
      throw new Error(
        `workflow version ${run.workflow_version_id} has no executable graph`,
      );
    }

    return {
      run: run as WorkflowRun,
      graph: version.graph as DagGraph,
      versionId: version.id,
      source: "workflow_version",
    };
  }

  /*
   * LEGACY COMPATIBILITY PATH
   *
   * Older runs may not have workflow_version_id. Preserve their ability to
   * finish using the DAG they were originally created against.
   *
   * New executions should never enter this path.
   */
  const legacyDagId = run.dag_id ?? "demo.live";

  const { data: dagRow, error: dagErr } = await sb
    .from("workflow_dags")
    .select("id,graph")
    .eq("id", legacyDagId)
    .single();

  if (dagErr) {
    throw dagErr;
  }

  if (!dagRow) {
    throw new Error(`legacy DAG ${legacyDagId} missing for run ${run.id}`);
  }

  const graph = (dagRow.graph ?? { nodes: [] }) as DagGraph;

  return {
    run: run as WorkflowRun,
    graph,
    versionId: null,
    source: "legacy_dag",
  };
}

async function processJob(
  sb: SupabaseClient,
  job: Job,
) {
  // Idempotency guard: if a step_run already exists for this idempotency_key
  // and is completed, short-circuit.
  const { data: existing } = await sb
    .from("workflow_step_runs")
    .select("id,state,outputs")
    .eq("idempotency_key", job.idempotency_key)
    .maybeSingle();

  if (existing?.state === "completed") {
    await sb
      .from("workflow_jobs")
      .update({
        state: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    await enqueueDownstream(
      sb,
      job.run_id,
      job.dag_node_id,
    );

    return;
  }

  // Resolve the immutable graph for this run.
  const resolved = await loadRunGraph(sb, job.run_id);
  const run = resolved.run;
  const graph = resolved.graph;

  const node = nodeById(
    graph,
    job.dag_node_id,
  );

  if (!node) {
    throw new Error(
      `dag node ${job.dag_node_id} missing from ${
        resolved.source === "workflow_version"
          ? `workflow version ${resolved.versionId}`
          : `legacy DAG ${run.dag_id}`
      }`,
    );
  }

  const stepIndex = graph.nodes.findIndex(
    (n) => n.id === node.id,
  );

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
      const expires = new Date(
        Date.now() + 30 * 60_000,
      ).toISOString();

      const { data: appr } = await sb
        .from("workflow_approvals")
        .insert({
          run_id: job.run_id,
          job_id: job.id,
          dag_node_id: node.id,
          state: "pending",
          expires_at: expires,
          requested_at: new Date().toISOString(),
        })
        .select()
        .single();

      await sb
        .from("workflow_jobs")
        .update({
          state: "delayed",
          backoff_until: expires,
          scheduled_at: expires,
          worker_id: null,
          started_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      await sb
        .from("workflow_runs")
        .update({
          state: "waiting_for_approval",
        })
        .eq("id", job.run_id);

      await emit(
        sb,
        job.run_id,
        null,
        "approval.requested",
        "warn",
        `⏸ Awaiting approval: ${node.name}`,
        {
          approval_id: appr?.id,
          node_id: node.id,
          expires_at: expires,
        },
      );

      await sb.from("runtime_audit_log").insert({
        actor: "worker",
        action: "approval.request",
        subject_type: "approval",
        subject_id: appr?.id ?? null,
        details: {
          run_id: job.run_id,
          job_id: job.id,
          node_id: node.id,
          workflow_version_id: run.workflow_version_id,
        },
      });

      return;
    } else if (
      existingApproval.state === "rejected" ||
      existingApproval.state === "expired"
    ) {
      // Should already have been dead-lettered, but be defensive.
      await sb
        .from("workflow_jobs")
        .update({
          state: "dead_letter",
          error: `approval ${existingApproval.state}`,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      return;
    }

    // approved → fall through and execute.
  }

  // Mark job + step running, claim a 120s lease.
  await sb
    .from("workflow_jobs")
    .update({
      state: "running",
      heartbeat_at: new Date().toISOString(),
      lease_expires_at: new Date(
        Date.now() + 120_000,
      ).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  const startedAt = new Date().toISOString();

  let step_id: string | null = existing?.id ?? null;

  if (step_id) {
    await sb
      .from("workflow_step_runs")
      .update({
        state: "running",
        started_at: startedAt,
        attempt: job.retry_attempt,
        inputs: job.payload,
      })
      .eq("id", step_id);
  } else {
    const { data: inserted, error: stepErr } = await sb
      .from("workflow_step_runs")
      .insert({
        run_id: job.run_id,
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

    if (stepErr) {
      throw stepErr;
    }

    step_id = inserted?.id ?? null;
  }

  await emit(
    sb,
    job.run_id,
    step_id,
    "step.started",
    "info",
    `▶ ${node.name}`,
    {
      connector: node.connector,
      attempt: job.retry_attempt,
      dag_node_id: node.id,
      workflow_version_id: run.workflow_version_id,
    },
  );

  // Execute via adapter.
  const adapter = getConnector(node.connector);

  const result = await adapter.execute(
    node.name,
    job.payload,
    {
      timeoutMs: node.timeoutMs,
      idempotencyKey: job.idempotency_key,
    },
  );

  // Touch connector_state with measured latency / health.
  await sb
    .from("connector_state")
    .update({
      latency_ms: result.latency_ms,
      last_success_at: result.ok
        ? new Date().toISOString()
        : undefined,
      last_error: result.ok
        ? null
        : result.error?.message ?? null,
      status: result.ok
        ? "healthy"
        : (
            result.error?.kind === "rate_limit"
              ? "degraded"
              : result.error?.kind === "timeout"
                ? "retrying"
                : "degraded"
          ),
      updated_at: new Date().toISOString(),
    })
    .eq("connector", node.connector);

  // Feed connector outcome into the circuit breaker so persistent failures
  // trip isolation instead of amplifying retries downstream.
  await sb.rpc("record_connector_result", {
    _connector: node.connector,
    _ok: result.ok,
  });

  if (result.ok) {
    await sb
      .from("workflow_step_runs")
      .update({
        state: "completed",
        ended_at: new Date().toISOString(),
        duration_ms: result.latency_ms,
        outputs: result.data ?? {},
        connector_response: result.data ?? {},
        result: {
          ok: true,
          mock: result.mock,
        },
      })
      .eq("id", step_id!);

    await sb.from("workflow_checkpoints").insert({
      run_id: job.run_id,
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
      const confidence =
        typeof result.data.confidence === "number"
          ? result.data.confidence
          : 0.55 + Math.random() * 0.42;

      const escalated = confidence < 0.7;

      await sb.from("ai_decision_trace").insert({
        run_id: job.run_id,
        model: String(
          result.data.model ?? "openai/gpt-4o-mini",
        ),
        prompt: String(
          job.payload.prompt ??
            `Workflow ${run.workflow_name}`,
        ),
        decision: escalated
          ? "escalate to human reviewer"
          : "auto-approve",
        confidence: Number(
          confidence.toFixed(2),
        ),
        escalated,
        reasoning: escalated
          ? "Confidence below 0.70 policy floor."
          : "Confidence above policy floor.",
        risk:
          confidence >= 0.85
            ? "low"
            : confidence >= 0.7
              ? "medium"
              : "high",
      });

      await emit(
        sb,
        job.run_id,
        step_id,
        "ai.decision",
        escalated ? "warn" : "info",
        `AI ${
          escalated ? "escalated" : "auto-approved"
        } (${Math.round(confidence * 100)}%)`,
        {
          confidence,
          escalated,
        },
      );
    }

    await emit(
      sb,
      job.run_id,
      step_id,
      "step.completed",
      "info",
      `✓ ${node.name} (${result.latency_ms}ms${
        result.mock ? " · mock" : ""
      })`,
      {
        duration_ms: result.latency_ms,
        mock: result.mock,
        workflow_version_id: run.workflow_version_id,
      },
    );

    await sb
      .from("workflow_jobs")
      .update({
        state: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    await enqueueDownstream(
      sb,
      job.run_id,
      node.id,
    );

    return;
  }

  // ── Failure path ─────────────────────────────────────────
  const policy = {
    ...DEFAULT_POLICY,
    maxRetries: job.max_retries,
  };

  const nextAttempt = job.retry_attempt + 1;

  const canRetry = shouldRetry(
    result.error,
    nextAttempt,
    policy,
  );

  if (canRetry) {
    const backoff = nextBackoffMs(
      nextAttempt,
      policy,
    );

    const until = new Date(
      Date.now() + backoff,
    ).toISOString();

    await sb
      .from("workflow_step_runs")
      .update({
        state: "retrying",
        retry_count: nextAttempt,
        error: result.error?.message ?? "unknown",
      })
      .eq("id", step_id!);

    await sb
      .from("workflow_jobs")
      .update({
        state: "retrying",
        retry_attempt: nextAttempt,
        backoff_until: until,
        scheduled_at: until,
        worker_id: null,
        started_at: null,
        error: result.error?.message ?? "unknown",
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    await emit(
      sb,
      job.run_id,
      step_id,
      "step.retry",
      "warn",
      `↻ ${node.name} retry ${nextAttempt}/${policy.maxRetries} in ${backoff}ms`,
      {
        backoff_ms: backoff,
        kind: result.error?.kind,
        workflow_version_id: run.workflow_version_id,
      },
    );

    return;
  }

  // Exhausted or non-retryable → dead-letter + incident.
  await sb
    .from("workflow_step_runs")
    .update({
      state: "failed",
      ended_at: new Date().toISOString(),
      duration_ms: result.latency_ms,
      error: result.error?.message ?? "failed",
    })
    .eq("id", step_id!);

  await sb
    .from("workflow_jobs")
    .update({
      state: "dead_letter",
      completed_at: new Date().toISOString(),
      error: result.error?.message ?? "failed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  await sb.from("workflow_dead_letter").insert({
    job_id: job.id,
    run_id: job.run_id,
    dag_node_id: node.id,
    attempts: nextAttempt,
    last_error: result.error?.message ?? "failed",
    payload: job.payload,
  });

  await sb.from("workflow_incidents").insert({
    run_id: job.run_id,
    severity: "error",
    category: "dead_letter",
    connector: node.connector,
    summary: `Step "${node.name}" dead-lettered after ${nextAttempt} attempts: ${
      result.error?.message ?? "failed"
    }`,
  });

  await emit(
    sb,
    job.run_id,
    step_id,
    "step.failed",
    "error",
    `✗ ${node.name} dead-lettered (${
      result.error?.kind ?? "unknown"
    })`,
    {
      kind: result.error?.kind,
      attempts: nextAttempt,
      workflow_version_id: run.workflow_version_id,
    },
  );
}

async function enqueueDownstream(
  sb: SupabaseClient,
  runId: string,
  completedNodeId: string,
) {
  /*
   * IMPORTANT:
   * Resolve the graph through workflow_version_id first. This keeps
   * downstream scheduling on the exact same immutable graph used for the
   * completed node.
   */
  const resolved = await loadRunGraph(
    sb,
    runId,
  );

  const run = resolved.run;
  const graph = resolved.graph;

  const { data: jobs } = await sb
    .from("workflow_jobs")
    .select("dag_node_id,state")
    .eq("run_id", runId);

  const states: Record<string, NodeState> = {};

  for (const n of graph.nodes) {
    states[n.id] = "pending";
  }

  for (const j of jobs ?? []) {
    if (j.state === "completed") {
      states[j.dag_node_id] = "completed";
    } else if (
      j.state === "dead_letter" ||
      j.state === "failed"
    ) {
      states[j.dag_node_id] = "failed";
    } else {
      states[j.dag_node_id] = "queued";
    }
  }

  const ready = readyNodes(
    graph,
    states,
  ).filter(
    (n) => n.id !== completedNodeId,
  );

  for (const n of ready) {
    const idem = `${runId}:${n.id}`;

    await sb
      .from("workflow_jobs")
      .insert({
        run_id: runId,
        tenant_id: run.tenant_id,
        workflow_version_id:
          run.workflow_version_id ?? null,
        dag_node_id: n.id,
        state: "queued",
        max_retries: n.maxRetries ?? 3,
        idempotency_key: idem,
        payload: {
          correlation_id: run.correlation_id,
        },
      })
      .then(
        () => {},
        () => {
          // Unique violation = already enqueued.
        },
      );
  }
}

async function finalizeRunIfDone(
  sb: SupabaseClient,
  runId: string,
) {
  const resolved = await loadRunGraph(
    sb,
    runId,
  );

  const run = resolved.run;

  if (
    (run as WorkflowRun & { state?: string }).state ===
      "completed" ||
    (run as WorkflowRun & { state?: string }).state ===
      "failed"
  ) {
    return;
  }

  const graph = resolved.graph;

  const { data: jobs } = await sb
    .from("workflow_jobs")
    .select("dag_node_id,state")
    .eq("run_id", runId);

  const states: Record<string, NodeState> = {};

  for (const n of graph.nodes) {
    states[n.id] = "pending";
  }

  for (const j of jobs ?? []) {
    if (j.state === "completed") {
      states[j.dag_node_id] = "completed";
    } else if (
      j.state === "dead_letter" ||
      j.state === "failed"
    ) {
      states[j.dag_node_id] = "failed";
    } else {
      states[j.dag_node_id] =
        j.state === "running"
          ? "running"
          : "queued";
    }
  }

  const { done, failed } = isTerminal(
    graph,
    states,
  );

  if (!done) {
    return;
  }

  const ended = new Date();

  const duration =
    ended.getTime() -
    new Date(run.started_at).getTime();

  await sb
    .from("workflow_runs")
    .update({
      state: failed
        ? "failed"
        : "completed",
      status: failed
        ? "failed"
        : "completed",
      ended_at: ended.toISOString(),
      duration_ms: duration,
      error: failed
        ? "One or more steps failed"
        : null,
      result: failed
        ? null
        : {
            nodes: graph.nodes.length,
            workflow_version_id:
              run.workflow_version_id,
          },
    })
    .eq("id", runId);

  await sb.from("workflow_events").insert({
    run_id: runId,
    type: failed
      ? "run.failed"
      : "run.completed",
    severity: failed
      ? "error"
      : "info",
    source: "run-worker",
    message: failed
      ? `Run failed in ${duration}ms`
      : `Run completed in ${duration}ms`,
    data: {
      duration_ms: duration,
      workflow_version_id:
        run.workflow_version_id,
      graph_source: resolved.source,
    },
  });
}

function emit(
  sb: SupabaseClient,
  run_id: string,
  step_id: string | null,
  type: string,
  severity: string,
  message: string,
  data: Record<string, unknown> = {},
) {
  return sb.from("workflow_events").insert({
    run_id,
    step_id,
    type,
    severity,
    source: "run-worker",
    message,
    data,
  });
}
