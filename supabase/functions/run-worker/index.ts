// Durable worker engine.
//
// Each invocation:
//   1. Atomically claims one job via claim_next_job().
//   2. Resolves the workflow graph from the run's immutable workflow version.
//   3. Resolves the DAG node + connector adapter.
//   4. Executes ONE step with adapter timeout + structured error.
//   5. Persists step_run + checkpoint + telemetry event.
//   6. On success: enqueues newly-ready downstream nodes.
//   7. On retryable failure: reschedules the SAME job with backoff.
//   8. On exhaustion: moves the job to dead_letter and opens an incident.
//   9. Finalizes workflow_runs whenever terminal state is reached.
//
// Versioning rule:
//   - New runs MUST use workflow_version_id.
//   - The worker resolves the immutable graph from workflow_versions.graph.
//   - Legacy workflow_dags fallback is retained only for older runs.
//
// Concurrency rule:
//   - Job completion/failure updates are scoped to the worker lease.
//   - Duplicate downstream jobs are treated as idempotent races.
//   - Approval gates remain paused until explicitly approved.
//   - Run finalization is safe to call repeatedly.
//
// This worker drains up to BATCH jobs per invocation.

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
  "Access-Control-Allow-Methods":
    "POST, OPTIONS",
};

const BATCH = 24;
const LEASE_MS = 120_000;

const WORKER_ID =
  `worker-${crypto.randomUUID().slice(0, 8)}`;

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
  worker_id?: string | null;
}

interface WorkflowRun {
  id: string;
  workflow_name: string;
  workflow_version_id: string | null;
  dag_id: string | null;
  correlation_id: string | null;
  tenant_id: string | null;
  started_at: string;
  state: string | null;
  status: string | null;
}

interface LoadedGraph {
  run: WorkflowRun;
  graph: DagGraph;
  versionId: string | null;
  source: "workflow_version" | "legacy_dag";
}

interface ApprovalRow {
  id: string;
  state: string;
  expires_at: string | null;
}

function json(
  body: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...cors,
        "Content-Type":
          "application/json",
      },
    },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(
      "ok",
      { headers: cors },
    );
  }

  if (req.method !== "POST") {
    return json(
      { error: "method not allowed" },
      405,
    );
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY",
    )!,
  );

  await registerWorker(sb);

  const { data: me } = await sb
    .from("worker_registry")
    .select("health_state")
    .eq("worker_id", WORKER_ID)
    .single();

  if (
    me?.health_state &&
    me.health_state !== "active"
  ) {
    return json({
      worker_id: WORKER_ID,
      processed: 0,
      drained: true,
    });
  }

  let processed = 0;

  const touchedRuns =
    new Set<string>();

  for (
    let i = 0;
    i < BATCH;
    i++
  ) {
    const {
      data: job,
      error: claimErr,
    } = await sb.rpc(
      "claim_next_job",
      {
        _worker_id:
          WORKER_ID,
      },
    );

    if (claimErr) {
      console.error(
        "[run-worker] claim error",
        claimErr,
      );
      break;
    }

    if (
      !job ||
      !job.id
    ) {
      break;
    }

    const claimedJob =
      job as Job;

    touchedRuns.add(
      claimedJob.run_id,
    );

    try {
      await processJob(
        sb,
        claimedJob,
      );
      processed++;
    } catch (error) {
      console.error(
        "[run-worker] process failed",
        error,
      );

      await failClaimedJob(
        sb,
        claimedJob,
        error,
      );
    }
  }

  await syncWorkerState(sb);

  for (
    const runId of touchedRuns
  ) {
    try {
      await finalizeRunIfDone(
        sb,
        runId,
      );
    } catch (error) {
      console.error(
        "[run-worker] finalization failed",
        {
          run_id: runId,
          error,
        },
      );
    }
  }

  if (
    processed >= BATCH
  ) {
    kickWorker();
  }

  return json({
    worker_id:
      WORKER_ID,
    processed,
  });
});

async function registerWorker(
  sb: SupabaseClient,
) {
  const region =
    Deno.env.get(
      "WORKER_REGION",
    ) ?? "default";

  const capabilities = (
    Deno.env.get(
      "WORKER_CAPABILITIES",
    ) ??
    "internal,stripe,openai,sendgrid,twilio,slack,salesforce"
  )
    .split(",")
    .map((value) =>
      value.trim()
    )
    .filter(Boolean);

  const now =
    new Date().toISOString();

  await sb
    .from(
      "worker_heartbeats",
    )
    .upsert({
      worker_id:
        WORKER_ID,
      last_seen_at:
        now,
      status:
        "alive",
    });

  await sb
    .from(
      "worker_registry",
    )
    .upsert(
      {
        worker_id:
          WORKER_ID,
        region,
        capabilities,
        last_heartbeat:
          now,
        health_state:
          "active",
      },
      {
        onConflict:
          "worker_id",
      },
    );
}

async function syncWorkerState(
  sb: SupabaseClient,
) {
  const {
    count: inflight,
  } = await sb
    .from(
      "workflow_jobs",
    )
    .select(
      "id",
      {
        count:
          "exact",
        head: true,
      },
    )
    .eq(
      "worker_id",
      WORKER_ID,
    )
    .in(
      "state",
      [
        "claimed",
        "running",
      ],
    );

  await sb
    .from(
      "worker_registry",
    )
    .update({
      active_jobs:
        inflight ?? 0,
      last_heartbeat:
        new Date().toISOString(),
    })
    .eq(
      "worker_id",
      WORKER_ID,
    );
}

async function failClaimedJob(
  sb: SupabaseClient,
  job: Job,
  error: unknown,
) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const now =
    new Date().toISOString();

  const {
    data: updated,
    error: updateErr,
  } = await sb
    .from(
      "workflow_jobs",
    )
    .update({
      state:
        "failed",
      error:
        message,
      updated_at:
        now,
      completed_at:
        now,
    })
    .eq(
      "id",
      job.id,
    )
    .eq(
      "worker_id",
      WORKER_ID,
    )
    .in(
      "state",
      [
        "claimed",
        "running",
      ],
    )
    .select("id")
    .maybeSingle();

  if (updateErr) {
    console.error(
      "[run-worker] failed to persist job failure",
      updateErr,
    );
    return;
  }

  if (!updated) {
    console.warn(
      "[run-worker] job lease no longer owned",
      {
        job_id:
          job.id,
        worker_id:
          WORKER_ID,
      },
    );
    return;
  }

  await sb
    .from(
      "workflow_events",
    )
    .insert({
      run_id:
        job.run_id,
      type:
        "step.failed",
      severity:
        "error",
      source:
        "run-worker",
      message:
        `Worker execution failed: ${message}`,
      data: {
        job_id:
          job.id,
        dag_node_id:
          job.dag_node_id,
        worker_id:
          WORKER_ID,
        workflow_version_id:
          null,
        error:
          message,
      },
    });
}

async function loadRunGraph(
  sb: SupabaseClient,
  runId: string,
): Promise<LoadedGraph> {
  const {
    data: run,
    error: runErr,
  } = await sb
    .from(
      "workflow_runs",
    )
    .select(
      [
        "id",
        "workflow_name",
        "workflow_version_id",
        "dag_id",
        "correlation_id",
        "tenant_id",
        "started_at",
        "state",
        "status",
      ].join(","),
    )
    .eq(
      "id",
      runId,
    )
    .single();

  if (runErr) {
    throw runErr;
  }

  if (!run) {
    throw new Error(
      `run ${runId} missing`,
    );
  }

  if (
    run.workflow_version_id
  ) {
    const {
      data: version,
      error: versionErr,
    } = await sb
      .from(
        "workflow_versions",
      )
      .select(
        "id,state,graph",
      )
      .eq(
        "id",
        run.workflow_version_id,
      )
      .single();

    if (versionErr) {
      throw versionErr;
    }

    if (!version) {
      throw new Error(
        `workflow version ${run.workflow_version_id} missing for run ${run.id}`,
      );
    }

    if (
      !version.graph ||
      !Array.isArray(
        version.graph.nodes,
      )
    ) {
      throw new Error(
        `workflow version ${run.workflow_version_id} has no executable graph`,
      );
    }

    return {
      run:
        run as WorkflowRun,
      graph:
        version.graph as DagGraph,
      versionId:
        version.id,
      source:
        "workflow_version",
    };
  }

  const legacyDagId =
    run.dag_id ??
    "demo.live";

  const {
    data: dagRow,
    error: dagErr,
  } = await sb
    .from(
      "workflow_dags",
    )
    .select(
      "id,graph",
    )
    .eq(
      "id",
      legacyDagId,
    )
    .single();

  if (dagErr) {
    throw dagErr;
  }

  if (!dagRow) {
    throw new Error(
      `legacy DAG ${legacyDagId} missing for run ${run.id}`,
    );
  }

  return {
    run:
      run as WorkflowRun,
    graph:
      (dagRow.graph ??
        {
          nodes: [],
        }) as DagGraph,
    versionId:
      null,
    source:
      "legacy_dag",
  };
}

async function processJob(
  sb: SupabaseClient,
  job: Job,
) {
  const {
    data: existing,
  } = await sb
    .from(
      "workflow_step_runs",
    )
    .select(
      "id,state,outputs",
    )
    .eq(
      "idempotency_key",
      job.idempotency_key,
    )
    .maybeSingle();

  if (
    existing?.state ===
    "completed"
  ) {
    await completeJob(
      sb,
      job,
    );

    await enqueueDownstream(
      sb,
      job.run_id,
      job.dag_node_id,
    );

    return;
  }

  const resolved =
    await loadRunGraph(
      sb,
      job.run_id,
    );

  const run =
    resolved.run;

  const graph =
    resolved.graph;

  const node =
    nodeById(
      graph,
      job.dag_node_id,
    );

  if (!node) {
    throw new Error(
      `dag node ${job.dag_node_id} missing from ${
        resolved.source ===
        "workflow_version"
          ? `workflow version ${resolved.versionId}`
          : `legacy DAG ${run.dag_id}`
      }`,
    );
  }

  const stepIndex =
    graph.nodes.findIndex(
      (n) =>
        n.id === node.id,
    );

  /*
   * Approval gate.
   *
   * Pending means the job MUST remain paused.
   * Approved means execution may continue.
   * Rejected/expired means the job is terminal.
   */
  if (
    node.approvalRequired
  ) {
    const {
      data: approval,
      error: approvalErr,
    } = await sb
      .from(
        "workflow_approvals",
      )
      .select(
        "id,state,expires_at",
      )
      .eq(
        "job_id",
        job.id,
      )
      .maybeSingle();

    if (approvalErr) {
      throw approvalErr;
    }

    if (!approval) {
      const expiresAt =
        new Date(
          Date.now() +
            30 * 60_000,
        ).toISOString();

      const {
        data: createdApproval,
        error: createApprovalErr,
      } = await sb
        .from(
          "workflow_approvals",
        )
        .insert({
          run_id:
            job.run_id,
          job_id:
            job.id,
          dag_node_id:
            node.id,
          state:
            "pending",
          expires_at:
            expiresAt,
          requested_at:
            new Date().toISOString(),
        })
        .select(
          "id,state,expires_at",
        )
        .single();

      if (
        createApprovalErr
      ) {
        /*
         * A concurrent worker may have created the approval between
         * SELECT and INSERT. Re-read it instead of creating a second
         * approval lifecycle.
         */
        const {
          data: concurrentApproval,
        } = await sb
          .from(
            "workflow_approvals",
          )
          .select(
            "id,state,expires_at",
          )
          .eq(
            "job_id",
            job.id,
          )
          .maybeSingle();

        if (
          concurrentApproval
        ) {
          await pauseForApproval(
            sb,
            job,
            node,
            concurrentApproval as ApprovalRow,
            run,
          );
          return;
        }

        throw createApprovalErr;
      }

      await pauseForApproval(
        sb,
        job,
        node,
        createdApproval as ApprovalRow,
        run,
      );

      return;
    }

    const approvalRow =
      approval as ApprovalRow;

    if (
      approvalRow.state ===
      "pending"
    ) {
      /*
       * Do NOT execute.
       *
       * The approval endpoint is responsible for changing the approval
       * to approved/rejected and re-queueing the job.
       */
      await pauseForApproval(
        sb,
        job,
        node,
        approvalRow,
        run,
      );
      return;
    }

    if (
      approvalRow.state ===
        "rejected" ||
      approvalRow.state ===
        "expired"
    ) {
      await terminalApprovalFailure(
        sb,
        job,
        node,
        approvalRow,
      );
      return;
    }

    // approved -> continue to execution.
  }

  const now =
    new Date().toISOString();

  const leaseExpires =
    new Date(
      Date.now() +
        LEASE_MS,
    ).toISOString();

  const {
    data: runningJob,
    error: runningErr,
  } = await sb
    .from(
      "workflow_jobs",
    )
    .update({
      state:
        "running",
      heartbeat_at:
        now,
      lease_expires_at:
        leaseExpires,
      updated_at:
        now,
    })
    .eq(
      "id",
      job.id,
    )
    .eq(
      "worker_id",
      WORKER_ID,
    )
    .eq(
      "state",
      "claimed",
    )
    .select("id")
    .maybeSingle();

  if (runningErr) {
    throw runningErr;
  }

  if (!runningJob) {
    throw new Error(
      `job ${job.id} is no longer owned by worker ${WORKER_ID}`,
    );
  }

  const startedAt =
    new Date().toISOString();

  let stepId:
    | string
    | null =
    existing?.id ??
    null;

  if (stepId) {
    const {
      error: stepUpdateErr,
    } = await sb
      .from(
        "workflow_step_runs",
      )
      .update({
        state:
          "running",
        started_at:
          startedAt,
        attempt:
          job.retry_attempt,
        inputs:
          job.payload,
      })
      .eq(
        "id",
        stepId,
      );

    if (stepUpdateErr) {
      throw stepUpdateErr;
    }
  } else {
    const {
      data: inserted,
      error: stepErr,
    } = await sb
      .from(
        "workflow_step_runs",
      )
      .insert({
        run_id:
          job.run_id,
        step_index:
          stepIndex,
        dag_node_id:
          node.id,
        name:
          node.name,
        connector:
          node.connector,
        state:
          "running",
        started_at:
          startedAt,
        attempt:
          job.retry_attempt,
        idempotency_key:
          job.idempotency_key,
        inputs:
          job.payload,
      })
      .select()
      .single();

    if (stepErr) {
      throw stepErr;
    }

    stepId =
      inserted?.id ??
      null;
  }

  if (!stepId) {
    throw new Error(
      `workflow step run could not be established for job ${job.id}`,
    );
  }

  await emit(
    sb,
    job.run_id,
    stepId,
    "step.started",
    "info",
    `▶ ${node.name}`,
    {
      connector:
        node.connector,
      attempt:
        job.retry_attempt,
      dag_node_id:
        node.id,
      workflow_version_id:
        run.workflow_version_id,
      worker_id:
        WORKER_ID,
    },
  );

  const adapter =
    getConnector(
      node.connector,
    );

  const result =
    await adapter.execute(
      node.name,
      job.payload,
      {
        timeoutMs:
          node.timeoutMs,
        idempotencyKey:
          job.idempotency_key,
      },
    );

  await sb
    .from(
      "connector_state",
    )
    .update({
      latency_ms:
        result.latency_ms,
      last_success_at:
        result.ok
          ? new Date().toISOString()
          : undefined,
      last_error:
        result.ok
          ? null
          : result.error
              ?.message ??
            null,
      status:
        result.ok
          ? "healthy"
          : result.error
              ?.kind ===
              "rate_limit"
            ? "degraded"
            : result.error
                ?.kind ===
                "timeout"
              ? "retrying"
              : "degraded",
      updated_at:
        new Date().toISOString(),
    })
    .eq(
      "connector",
      node.connector,
    );

  await sb.rpc(
    "record_connector_result",
    {
      _connector:
        node.connector,
      _ok:
        result.ok,
    },
  );

  if (result.ok) {
    await completeStep(
      sb,
      job,
      run,
      node,
      stepId,
      stepIndex,
      result,
    );

    await completeJob(
      sb,
      job,
    );

    await enqueueDownstream(
      sb,
      job.run_id,
      node.id,
    );

    return;
  }

  await handleStepFailure(
    sb,
    job,
    run,
    node,
    stepId,
    result,
  );
}

async function pauseForApproval(
  sb: SupabaseClient,
  job: Job,
  node: any,
  approval: ApprovalRow,
  run: WorkflowRun,
) {
  const expiresAt =
    approval.expires_at ??
    new Date(
      Date.now() +
        30 * 60_000,
    ).toISOString();

  await sb
    .from(
      "workflow_jobs",
    )
    .update({
      state:
        "delayed",
      backoff_until:
        expiresAt,
      scheduled_at:
        expiresAt,
      worker_id:
        null,
      started_at:
        null,
      updated_at:
        new Date().toISOString(),
    })
    .eq(
      "id",
      job.id,
    )
    .eq(
      "worker_id",
      WORKER_ID,
    );

  await sb
    .from(
      "workflow_runs",
    )
    .update({
      state:
        "waiting_for_approval",
      status:
        "waiting_for_approval",
    })
    .eq(
      "id",
      job.run_id,
    );

  await emit(
    sb,
    job.run_id,
    null,
    "approval.requested",
    "warn",
    `⏸ Awaiting approval: ${node.name}`,
    {
      approval_id:
        approval.id,
      node_id:
        node.id,
      expires_at:
        expiresAt,
      workflow_version_id:
        run.workflow_version_id,
    },
  );

  await sb
    .from(
      "runtime_audit_log",
    )
    .insert({
      actor:
        "worker",
      action:
        "approval.request",
      subject_type:
        "approval",
      subject_id:
        approval.id,
      details: {
        run_id:
          job.run_id,
        job_id:
          job.id,
        node_id:
          node.id,
        workflow_version_id:
          run.workflow_version_id,
      },
    });
}

async function terminalApprovalFailure(
  sb: SupabaseClient,
  job: Job,
  node: any,
  approval: ApprovalRow,
) {
  const reason =
    `approval ${approval.state}`;

  const now =
    new Date().toISOString();

  await sb
    .from(
      "workflow_jobs",
    )
    .update({
      state:
        "dead_letter",
      error:
        reason,
      completed_at:
        now,
      updated_at:
        now,
    })
    .eq(
      "id",
      job.id,
    )
    .eq(
      "worker_id",
      WORKER_ID,
    );

  await sb
    .from(
      "workflow_incidents",
    )
    .insert({
      run_id:
        job.run_id,
      severity:
        "error",
      category:
        "approval",
      connector:
        node.connector,
      summary:
        `Step "${node.name}" blocked because approval was ${approval.state}`,
    });

  await emit(
    sb,
    job.run_id,
    null,
    "approval.failed",
    "error",
    `Approval ${approval.state}: ${node.name}`,
    {
      approval_id:
        approval.id,
      node_id:
        node.id,
      state:
        approval.state,
    },
  );
}

async function completeStep(
  sb: SupabaseClient,
  job: Job,
  run: WorkflowRun,
  node: any,
  stepId: string,
  stepIndex: number,
  result: any,
) {
  const now =
    new Date().toISOString();

  await sb
    .from(
      "workflow_step_runs",
    )
    .update({
      state:
        "completed",
      ended_at:
        now,
      duration_ms:
        result.latency_ms,
      outputs:
        result.data ??
        {},
      connector_response:
        result.data ??
        {},
      result: {
        ok:
          true,
        mock:
          result.mock,
      },
    })
    .eq(
      "id",
      stepId,
    );

  await sb
    .from(
      "workflow_checkpoints",
    )
    .insert({
      run_id:
        job.run_id,
      workflow_version_id:
        run.workflow_version_id ??
        null,
      step_index:
        stepIndex,
      snapshot: {
        node_id:
          node.id,
        name:
          node.name,
        connector:
          node.connector,
        inputs:
          job.payload,
        outputs:
          result.data ??
          {},
        attempt:
          job.retry_attempt,
        idempotency_key:
          job.idempotency_key,
        correlation_id:
          run.correlation_id,
        workflow_version_id:
          run.workflow_version_id ??
          null,
        mock:
          result.mock,
      },
    });

  if (
    node.connector ===
      "openai" &&
    result.data
  ) {
    const confidence =
      typeof result
        .data.confidence ===
      "number"
        ? result.data
            .confidence
        : 0.55 +
          Math.random() *
            0.42;

    const escalated =
      confidence < 0.7;

    await sb
      .from(
        "ai_decision_trace",
      )
      .insert({
        run_id:
          job.run_id,
        model:
          String(
            result.data
              .model ??
              "openai/gpt-4o-mini",
          ),
        prompt:
          String(
            job.payload
              .prompt ??
              `Workflow ${run.workflow_name}`,
          ),
        decision:
          escalated
            ? "escalate to human reviewer"
            : "auto-approve",
        confidence:
          Number(
            confidence.toFixed(
              2,
            ),
          ),
        escalated,
        reasoning:
          escalated
            ? "Confidence below 0.70 policy floor."
            : "Confidence above policy floor.",
        risk:
          confidence >=
          0.85
            ? "low"
            : confidence >=
                0.7
              ? "medium"
              : "high",
      });

    await emit(
      sb,
      job.run_id,
      stepId,
      "ai.decision",
      escalated
        ? "warn"
        : "info",
      `AI ${
        escalated
          ? "escalated"
          : "auto-approved"
      } (${Math.round(
        confidence * 100,
      )}%)`,
      {
        confidence,
        escalated,
        workflow_version_id:
          run.workflow_version_id,
      },
    );
  }

  await emit(
    sb,
    job.run_id,
    stepId,
    "step.completed",
    "info",
    `✓ ${node.name} (${result.latency_ms}ms${
      result.mock
        ? " · mock"
        : ""
    })`,
    {
      duration_ms:
        result.latency_ms,
      mock:
        result.mock,
      workflow_version_id:
        run.workflow_version_id,
      worker_id:
        WORKER_ID,
    },
  );
}

async function completeJob(
  sb: SupabaseClient,
  job: Job,
) {
  const now =
    new Date().toISOString();

  const {
    data,
    error,
  } = await sb
    .from(
      "workflow_jobs",
    )
    .update({
      state:
        "completed",
      completed_at:
        now,
      updated_at:
        now,
      worker_id:
        null,
    })
    .eq(
      "id",
      job.id,
    )
    .eq(
      "worker_id",
      WORKER_ID,
    )
    .in(
      "state",
      [
        "claimed",
        "running",
      ],
    )
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(
      `job ${job.id} completion lost worker lease`,
    );
  }
}

async function handleStepFailure(
  sb: SupabaseClient,
  job: Job,
  run: WorkflowRun,
  node: any,
  stepId: string,
  result: any,
) {
  const policy = {
    ...DEFAULT_POLICY,
    maxRetries:
      job.max_retries,
  };

  const nextAttempt =
    job.retry_attempt + 1;

  const canRetry =
    shouldRetry(
      result.error,
      nextAttempt,
      policy,
    );

  if (canRetry) {
    const backoff =
      nextBackoffMs(
        nextAttempt,
        policy,
      );

    const until =
      new Date(
        Date.now() +
          backoff,
      ).toISOString();

    await sb
      .from(
        "workflow_step_runs",
      )
      .update({
        state:
          "retrying",
        retry_count:
          nextAttempt,
        error:
          result.error
            ?.message ??
          "unknown",
      })
      .eq(
        "id",
        stepId,
      );

    await sb
      .from(
        "workflow_jobs",
      )
      .update({
        state:
          "retrying",
        retry_attempt:
          nextAttempt,
        backoff_until:
          until,
        scheduled_at:
          until,
        worker_id:
          null,
        started_at:
          null,
        lease_expires_at:
          null,
        error:
          result.error
            ?.message ??
          "unknown",
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        job.id,
      )
      .eq(
        "worker_id",
        WORKER_ID,
      );

    await emit(
      sb,
      job.run_id,
      stepId,
      "step.retry",
      "warn",
      `↻ ${node.name} retry ${nextAttempt}/${policy.maxRetries} in ${backoff}ms`,
      {
        backoff_ms:
          backoff,
        kind:
          result.error
            ?.kind,
        workflow_version_id:
          run.workflow_version_id,
      },
    );

    return;
  }

  await sb
    .from(
      "workflow_step_runs",
    )
    .update({
      state:
        "failed",
      ended_at:
        new Date().toISOString(),
      duration_ms:
        result.latency_ms,
      error:
        result.error
          ?.message ??
        "failed",
    })
    .eq(
      "id",
      stepId,
    );

  await sb
    .from(
      "workflow_jobs",
    )
    .update({
      state:
        "dead_letter",
      completed_at:
        new Date().toISOString(),
      error:
        result.error
          ?.message ??
        "failed",
      updated_at:
        new Date().toISOString(),
      worker_id:
        null,
    })
    .eq(
      "id",
      job.id,
    )
    .eq(
      "worker_id",
      WORKER_ID,
    );

  await sb
    .from(
      "workflow_dead_letter",
    )
    .insert({
      job_id:
        job.id,
      run_id:
        job.run_id,
      dag_node_id:
        node.id,
      attempts:
        nextAttempt,
      last_error:
        result.error
          ?.message ??
        "failed",
      payload:
        job.payload,
    });

  await sb
    .from(
      "workflow_incidents",
    )
    .insert({
      run_id:
        job.run_id,
      severity:
        "error",
      category:
        "dead_letter",
      connector:
        node.connector,
      summary:
        `Step "${node.name}" dead-lettered after ${nextAttempt} attempts: ${
          result.error
            ?.message ??
          "failed"
        }`,
    });

  await emit(
    sb,
    job.run_id,
    stepId,
    "step.failed",
    "error",
    `✗ ${node.name} dead-lettered (${
      result.error
        ?.kind ??
      "unknown"
    })`,
    {
      kind:
        result.error
          ?.kind,
      attempts:
        nextAttempt,
      workflow_version_id:
        run.workflow_version_id,
    },
  );
}

async function enqueueDownstream(
  sb: SupabaseClient,
  runId: string,
  completedNodeId: string,
) {
  const resolved =
    await loadRunGraph(
      sb,
      runId,
    );

  const run =
    resolved.run;

  const graph =
    resolved.graph;

  const {
    data: jobs,
    error: jobsErr,
  } = await sb
    .from(
      "workflow_jobs",
    )
    .select(
      "dag_node_id,state",
    )
    .eq(
      "run_id",
      runId,
    );

  if (jobsErr) {
    throw jobsErr;
  }

  const states:
    Record<
      string,
      NodeState
    > = {};

  for (
    const node of graph.nodes
  ) {
    states[node.id] =
      "pending";
  }

  for (
    const job of jobs ??
    []
  ) {
    if (
      job.state ===
      "completed"
    ) {
      states[
        job.dag_node_id
      ] =
        "completed";
    } else if (
      job.state ===
        "dead_letter" ||
      job.state ===
        "failed"
    ) {
      states[
        job.dag_node_id
      ] =
        "failed";
    } else if (
      job.state ===
      "delayed"
    ) {
      states[
        job.dag_node_id
      ] =
        "queued";
    } else {
      states[
        job.dag_node_id
      ] =
        "queued";
    }
  }

  const ready =
    readyNodes(
      graph,
      states,
    ).filter(
      (node) =>
        node.id !==
        completedNodeId,
    );

  for (
    const node of ready
  ) {
    const idempotencyKey =
      `${runId}:${node.id}`;

    const {
      error: insertErr,
    } = await sb
      .from(
        "workflow_jobs",
      )
      .insert({
        run_id:
          runId,
        tenant_id:
          run.tenant_id,
        workflow_version_id:
          run.workflow_version_id ??
          null,
        dag_node_id:
          node.id,
        state:
          "queued",
        max_retries:
          node.maxRetries ??
          3,
        idempotency_key:
          idempotencyKey,
        payload: {
          correlation_id:
            run.correlation_id,
        },
      });

    if (insertErr) {
      /*
       * Duplicate downstream scheduling is expected when two completed
       * dependency paths race. Other database errors are real failures.
       */
      const code =
        (insertErr as {
          code?: string;
        }).code;

      if (
        code !==
        "23505"
      ) {
        throw insertErr;
      }
    }
  }
}

async function finalizeRunIfDone(
  sb: SupabaseClient,
  runId: string,
) {
  const resolved =
    await loadRunGraph(
      sb,
      runId,
    );

  const run =
    resolved.run;

  if (
    run.state ===
      "completed" ||
    run.state ===
      "failed" ||
    run.state ===
      "rolled_back" ||
    run.state ===
      "rollback_failed"
  ) {
    return;
  }

  if (
    run.state ===
    "waiting_for_approval"
  ) {
    return;
  }

  const graph =
    resolved.graph;

  const {
    data: jobs,
    error: jobsErr,
  } = await sb
    .from(
      "workflow_jobs",
    )
    .select(
      "dag_node_id,state",
    )
    .eq(
      "run_id",
      runId,
    );

  if (jobsErr) {
    throw jobsErr;
  }

  const states:
    Record<
      string,
      NodeState
    > = {};

  for (
    const node of graph.nodes
  ) {
    states[node.id] =
      "pending";
  }

  for (
    const job of jobs ??
    []
  ) {
    if (
      job.state ===
      "completed"
    ) {
      states[
        job.dag_node_id
      ] =
        "completed";
    } else if (
      job.state ===
        "dead_letter" ||
      job.state ===
        "failed"
    ) {
      states[
        job.dag_node_id
      ] =
        "failed";
    } else if (
      job.state ===
      "running"
    ) {
      states[
        job.dag_node_id
      ] =
        "running";
    } else {
      states[
        job.dag_node_id
      ] =
        "queued";
    }
  }

  const {
    done,
    failed,
  } = isTerminal(
    graph,
    states,
  );

  if (!done) {
    return;
  }

  const ended =
    new Date();

  const duration =
    ended.getTime() -
    new Date(
      run.started_at,
    ).getTime();

  const finalState =
    failed
      ? "failed"
      : "completed";

  const {
    error: finalizeErr,
  } = await sb
    .from(
      "workflow_runs",
    )
    .update({
      state:
        finalState,
      status:
        finalState,
      ended_at:
        ended.toISOString(),
      duration_ms:
        duration,
      error:
        failed
          ? "One or more steps failed"
          : null,
      result:
        failed
          ? null
          : {
              nodes:
                graph.nodes
                  .length,
              workflow_version_id:
                run.workflow_version_id,
            },
    })
    .eq(
      "id",
      runId,
    )
    .in(
      "state",
      [
        "queued",
        "running",
        "waiting_for_approval",
      ],
    );

  if (finalizeErr) {
    throw finalizeErr;
  }

  await sb
    .from(
      "workflow_events",
    )
    .insert({
      run_id:
        runId,
      type:
        failed
          ? "run.failed"
          : "run.completed",
      severity:
        failed
          ? "error"
          : "info",
      source:
        "run-worker",
      message:
        failed
          ? `Run failed in ${duration}ms`
          : `Run completed in ${duration}ms`,
      data: {
        duration_ms:
          duration,
        workflow_version_id:
          run.workflow_version_id,
        graph_source:
          resolved.source,
      },
    });
}

async function emit(
  sb: SupabaseClient,
  runId: string,
  stepId: string | null,
  type: string,
  severity: string,
  message: string,
  data:
    Record<
      string,
      unknown
    > = {},
) {
  const {
    data: run,
  } = await sb
    .from(
      "workflow_runs",
    )
    .select(
      "tenant_id,workflow_version_id",
    )
    .eq(
      "id",
      runId,
    )
    .maybeSingle();

  return sb
    .from(
      "workflow_events",
    )
    .insert({
      run_id:
        runId,
      step_id:
        stepId,
      tenant_id:
        run?.tenant_id ??
        null,
      type,
      severity,
      source:
        "run-worker",
      message,
      data: {
        ...data,
        workflow_version_id:
          data.workflow_version_id ??
          run?.workflow_version_id ??
          null,
      },
    });
}

function kickWorker() {
  const url =
    Deno.env.get(
      "SUPABASE_URL",
    );

  const key =
    Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY",
    );

  if (!url || !key) {
    return;
  }

  fetch(
    `${url}/functions/v1/run-worker`,
    {
      method:
        "POST",
      headers: {
        "Content-Type":
          "application/json",
        Authorization:
          `Bearer ${key}`,
      },
      body:
        "{}",
    },
  ).catch(
    (error) => {
      console.error(
        "[run-worker] follow-on worker kick failed",
        error instanceof Error
          ? error.message
          : String(error),
      );
    },
  );
}
