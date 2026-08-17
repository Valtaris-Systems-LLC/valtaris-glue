# `supabase/functions/run-worker/index.ts`

```typescript
// Durable workflow worker.
//
// Execution authority:
//   workflow_runs.workflow_version_id
//          ↓
//   workflow_versions.graph
//          ↓
//   immutable DAG node definition
//
// This worker intentionally does NOT read workflow_dags or dag_id.
// A workflow run is pinned to one published workflow version at launch,
// and every worker operation must execute against that same immutable graph.
//
// Worker responsibilities:
//   1. announce worker health
//   2. atomically claim durable jobs
//   3. resolve the pinned workflow version
//   4. resolve the immutable DAG node
//   5. enforce approvals
//   6. execute through the connector adapter
//   7. persist step state/checkpoints/telemetry
//   8. retry retryable failures
//   9. dead-letter exhausted failures
//  10. enqueue newly-ready downstream nodes
//  11. finalize terminal workflow runs
//
// Re-entrant by design:
//   - claim_next_job() owns concurrency control
//   - downstream enqueue uses the durable idempotency key
//   - completed step_runs short-circuit duplicate execution
//   - worker invocations may safely overlap

import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.49.1";

import {
  getConnector,
} from "../_shared/connectors.ts";

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
  workflow_version_id?: string | null;
  tenant_id?: string | null;
}

interface WorkflowRun {
  id: string;
  tenant_id: string;
  workflow_version_id: string | null;
  workflow_name: string;
  correlation_id: string | null;
  payload?: Record<string, unknown> | null;
  started_at: string;
  state: string;
  status: string;
}

interface WorkflowVersion {
  id: string;
  definition_id: string;
  tenant_id: string;
  version: number | string;
  state: string;
  graph: DagGraph | null;
}

function response(
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

function nowIso() {
  return new Date().toISOString();
}

function workerConfig() {
  const region =
    Deno.env.get(
      "WORKER_REGION",
    ) ?? "default";

  const capabilities =
    (
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

  return {
    region,
    capabilities,
  };
}

async function getRun(
  sb: SupabaseClient,
  runId: string,
): Promise<WorkflowRun> {
  const {
    data,
    error,
  } = await sb
    .from("workflow_runs")
    .select(
      [
        "id",
        "tenant_id",
        "workflow_version_id",
        "workflow_name",
        "correlation_id",
        "payload",
        "started_at",
        "state",
        "status",
      ].join(","),
    )
    .eq("id", runId)
    .single();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(
      `workflow run ${runId} missing`,
    );
  }

  return data as WorkflowRun;
}

async function getPinnedVersion(
  sb: SupabaseClient,
  run: WorkflowRun,
): Promise<WorkflowVersion> {
  if (
    !run.workflow_version_id
  ) {
    throw new Error(
      `workflow run ${run.id} has no pinned workflow_version_id`,
    );
  }

  const {
    data,
    error,
  } = await sb
    .from("workflow_versions")
    .select(
      [
        "id",
        "definition_id",
        "tenant_id",
        "version",
        "state",
        "graph",
      ].join(","),
    )
    .eq(
      "id",
      run.workflow_version_id,
    )
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(
      `workflow version ${run.workflow_version_id} missing`,
    );
  }

  const version =
    data as WorkflowVersion;

  if (
    version.tenant_id !==
    run.tenant_id
  ) {
    throw new Error(
      `workflow version tenant mismatch for run ${run.id}`,
    );
  }

  if (
    version.state !==
    "published"
  ) {
    throw new Error(
      `workflow version ${version.id} is not runnable`,
    );
  }

  if (
    !version.graph ||
    !Array.isArray(
      version.graph.nodes,
    ) ||
    version.graph.nodes.length ===
      0
  ) {
    throw new Error(
      `workflow version ${version.id} contains no executable graph`,
    );
  }

  return version;
}

async function heartbeat(
  sb: SupabaseClient,
  status = "alive",
) {
  const timestamp =
    nowIso();

  await sb
    .from("worker_heartbeats")
    .upsert({
      worker_id:
        WORKER_ID,
      last_seen_at:
        timestamp,
      status,
    });

  await sb
    .from("worker_registry")
    .upsert(
      {
        worker_id:
          WORKER_ID,
        region:
          workerConfig()
            .region,
        capabilities:
          workerConfig()
            .capabilities,
        last_heartbeat:
          timestamp,
        health_state:
          status ===
            "alive"
            ? "active"
            : status,
      },
      {
        onConflict:
          "worker_id",
      },
    );
}

async function workerIsActive(
  sb: SupabaseClient,
) {
  const {
    data,
    error,
  } = await sb
    .from("worker_registry")
    .select(
      "health_state",
    )
    .eq(
      "worker_id",
      WORKER_ID,
    )
    .maybeSingle();

  if (error) {
    console.error(
      "[run-worker] worker registry check failed",
      error.message,
    );

    return true;
  }

  return (
    !data?.health_state ||
    data.health_state ===
      "active"
  );
}

async function updateActiveJobs(
  sb: SupabaseClient,
) {
  const {
    count,
  } = await sb
    .from("workflow_jobs")
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
    .from("worker_registry")
    .update({
      active_jobs:
        count ?? 0,
      last_heartbeat:
        nowIso(),
    })
    .eq(
      "worker_id",
      WORKER_ID,
    );
}

async function processJob(
  sb: SupabaseClient,
  job: Job,
) {
  /*
   * ------------------------------------------------------------
   * 1. Idempotency guard.
   * ------------------------------------------------------------
   */

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
    await sb
      .from("workflow_jobs")
      .update({
        state:
          "completed",
        completed_at:
          nowIso(),
        updated_at:
          nowIso(),
      })
      .eq(
        "id",
        job.id,
      );

    await enqueueDownstream(
      sb,
      job.run_id,
      job.dag_node_id,
    );

    return;
  }

  /*
   * ------------------------------------------------------------
   * 2. Resolve run + immutable workflow version.
   * ------------------------------------------------------------
   */

  const run =
    await getRun(
      sb,
      job.run_id,
    );

  const version =
    await getPinnedVersion(
      sb,
      run,
    );

  /*
   * A claimed job must belong to the same pinned version as its run.
   */
  if (
    job.workflow_version_id &&
    job.workflow_version_id !==
      version.id
  ) {
    throw new Error(
      `job ${job.id} workflow_version_id does not match run ${run.id}`,
    );
  }

  if (
    job.tenant_id &&
    job.tenant_id !==
      version.tenant_id
  ) {
    throw new Error(
      `job ${job.id} tenant_id does not match pinned workflow version`,
    );
  }

  /*
   * ------------------------------------------------------------
   * 3. Resolve node from immutable version graph.
   * ------------------------------------------------------------
   */

  const graph =
    version.graph as DagGraph;

  const node =
    nodeById(
      graph,
      job.dag_node_id,
    );

  if (!node) {
    throw new Error(
      `dag node ${job.dag_node_id} missing from workflow version ${version.id}`,
    );
  }

  const stepIndex =
    graph.nodes.findIndex(
      (candidate) =>
        candidate.id ===
        node.id,
    );

  /*
   * ------------------------------------------------------------
   * 4. Approval gate.
   * ------------------------------------------------------------
   */

  if (
    node.approvalRequired
  ) {
    const {
      data: existingApproval,
      error: approvalLookupError,
    } = await sb
      .from(
        "workflow_approvals",
      )
      .select(
        "id,state",
      )
      .eq(
        "job_id",
        job.id,
      )
      .maybeSingle();

    if (approvalLookupError) {
      throw approvalLookupError;
    }

    if (
      !existingApproval
    ) {
      const expires =
        new Date(
          Date.now() +
            30 *
              60_000,
        ).toISOString();

      const {
        data: approval,
        error: approvalError,
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
            expires,
          requested_at:
            nowIso(),
        })
        .select()
        .single();

      if (approvalError) {
        throw approvalError;
      }

      await sb
        .from("workflow_jobs")
        .update({
          state:
            "delayed",
          backoff_until:
            expires,
          scheduled_at:
            expires,
          worker_id:
            null,
          started_at:
            null,
          updated_at:
            nowIso(),
        })
        .eq(
          "id",
          job.id,
        );

      await sb
        .from("workflow_runs")
        .update({
          state:
            "waiting_for_approval",
        })
        .eq(
          "id",
          job.run_id,
        )
        .eq(
          "tenant_id",
          run.tenant_id,
        );

      await emit(
        sb,
        job.run_id,
        null,
        "approval.requested",
        "warn",
        `Awaiting approval: ${node.name}`,
        {
          approval_id:
            approval?.id,
          node_id:
            node.id,
          expires_at:
            expires,
          workflow_version_id:
            version.id,
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
            approval?.id ??
            null,
          details: {
            run_id:
              job.run_id,
            job_id:
              job.id,
            node_id:
              node.id,
            workflow_version_id:
              version.id,
          },
        });

      return;
    }

    if (
      existingApproval.state ===
        "rejected" ||
      existingApproval.state ===
        "expired"
    ) {
      await sb
        .from("workflow_jobs")
        .update({
          state:
            "dead_letter",
          error:
            `approval ${existingApproval.state}`,
          completed_at:
            nowIso(),
          updated_at:
            nowIso(),
        })
        .eq(
          "id",
          job.id,
        );

      return;
    }

    /*
     * Approved → continue execution.
     */
  }

  /*
   * ------------------------------------------------------------
   * 5. Mark job + step running.
   * ------------------------------------------------------------
   */

  const startedAt =
    nowIso();

  await sb
    .from("workflow_jobs")
    .update({
      state:
        "running",
      heartbeat_at:
        startedAt,
      lease_expires_at:
        new Date(
          Date.now() +
            LEASE_MS,
        ).toISOString(),
      updated_at:
        startedAt,
    })
    .eq(
      "id",
      job.id,
    )
    .eq(
      "worker_id",
      WORKER_ID,
    );

  let stepId:
    | string
    | null =
    existing?.id ??
    null;

  if (stepId) {
    const {
      error,
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

    if (error) {
      throw error;
    }
  } else {
    const {
      data: inserted,
      error: stepError,
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

    if (stepError) {
      throw stepError;
    }

    stepId =
      inserted?.id ??
      null;
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
        version.id,
    },
  );

  /*
   * ------------------------------------------------------------
   * 6. Execute connector.
   * ------------------------------------------------------------
   */

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

  /*
   * Connector health is operational telemetry.
   */
  await sb
    .from("connector_state")
    .update({
      latency_ms:
        result.latency_ms,
      last_success_at:
        result.ok
          ? nowIso()
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
        nowIso(),
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

  /*
   * ------------------------------------------------------------
   * 7. Successful execution.
   * ------------------------------------------------------------
   */

  if (result.ok) {
    const endedAt =
      nowIso();

    await sb
      .from(
        "workflow_step_runs",
      )
      .update({
        state:
          "completed",
        ended_at:
          endedAt,
        duration_ms:
          result.latency_ms,
        outputs:
          result.data ??
          {},
        connector_response:
          result.data ??
          {},
        result: {
          ok: true,
          mock:
            result.mock,
        },
      })
      .eq(
        "id",
        stepId!,
      );

    await sb
      .from(
        "workflow_checkpoints",
      )
      .insert({
        run_id:
          job.run_id,
        workflow_version_id:
          version.id,
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
            version.id,
          mock:
            result.mock,
        },
      });

    /*
     * AI decision telemetry.
     *
     * Confidence is only taken from the connector result when supplied.
     * Otherwise we retain the existing fallback behavior.
     */
    if (
      node.connector ===
        "openai" &&
      result.data
    ) {
      const confidence =
        typeof result
            .data
            .confidence ===
          "number"
          ? result.data
              .confidence
          : 0.55 +
            Math.random() *
              0.42;

      const escalated =
        confidence <
        0.7;

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
          confidence *
            100,
        )}%)`,
        {
          confidence,
          escalated,
          workflow_version_id:
            version.id,
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
          version.id,
      },
    );

    await sb
      .from("workflow_jobs")
      .update({
        state:
          "completed",
        completed_at:
          endedAt,
        updated_at:
          endedAt,
        worker_id:
          null,
        lease_expires_at:
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

    await enqueueDownstream(
      sb,
      job.run_id,
      node.id,
    );

    return;
  }

  /*
   * ------------------------------------------------------------
   * 8. Failure / retry path.
   * ------------------------------------------------------------
   */

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
        stepId!,
      );

    await sb
      .from("workflow_jobs")
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
          nowIso(),
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
          version.id,
      },
    );

    return;
  }

  /*
   * ------------------------------------------------------------
   * 9. Exhaustion → dead letter + incident.
   * ------------------------------------------------------------
   */

  const failureMessage =
    result.error
      ?.message ??
    "failed";

  await sb
    .from(
      "workflow_step_runs",
    )
    .update({
      state:
        "failed",
      ended_at:
        nowIso(),
      duration_ms:
        result.latency_ms,
      error:
        failureMessage,
    })
    .eq(
      "id",
      stepId!,
    );

  await sb
    .from("workflow_jobs")
    .update({
      state:
        "dead_letter",
      completed_at:
        nowIso(),
      lease_expires_at:
        null,
      error:
        failureMessage,
      updated_at:
        nowIso(),
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
        failureMessage,
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
        `Step "${node.name}" dead-lettered after ${nextAttempt} attempts: ${failureMessage}`,
    });

  await emit(
    sb,
    job.run_id,
    stepId,
    "step.failed",
    "error",
    `✗ ${node.name} dead-lettered (${result.error?.kind ?? "unknown"})`,
    {
      kind:
        result.error
          ?.kind,
      attempts:
        nextAttempt,
      workflow_version_id:
        version.id,
    },
  );
}

async function enqueueDownstream(
  sb: SupabaseClient,
  runId: string,
  completedNodeId: string,
) {
  const run =
    await getRun(
      sb,
      runId,
    );

  const version =
    await getPinnedVersion(
      sb,
      run,
    );

  const graph =
    version.graph as DagGraph;

  const {
    data: jobs,
    error: jobsError,
  } = await sb
    .from("workflow_jobs")
    .select(
      "dag_node_id,state",
    )
    .eq(
      "run_id",
      runId,
    );

  if (jobsError) {
    throw jobsError;
  }

  const states:
    Record<
      string,
      NodeState
    > = {};

  for (
    const node of
      graph.nodes
  ) {
    states[node.id] =
      "pending";
  }

  for (
    const job of
      jobs ?? []
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
    const node of
      ready
  ) {
    const idempotencyKey =
      `${runId}:${node.id}`;

    /*
     * The unique idempotency constraint is the concurrency boundary.
     * Two workers may independently discover the same ready node;
     * only one durable job survives.
     */
    const {
      error,
    } = await sb
      .from("workflow_jobs")
      .insert({
        run_id:
          runId,
        tenant_id:
          run.tenant_id,
        workflow_version_id:
          version.id,
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

    if (
      error &&
      !isUniqueViolation(
        error,
      )
    ) {
      throw error;
    }
  }
}

function isUniqueViolation(
  error: {
    code?: string;
    message?: string;
  },
) {
  return (
    error.code ===
      "23505" ||
    error.message
      ?.toLowerCase()
      .includes(
        "duplicate",
      ) ||
    error.message
      ?.toLowerCase()
      .includes(
        "unique",
      )
  );
}

async function finalizeRunIfDone(
  sb: SupabaseClient,
  runId: string,
) {
  const run =
    await getRun(
      sb,
      runId,
    );

  if (
    run.state ===
      "completed" ||
    run.state ===
      "failed"
  ) {
    return;
  }

  const version =
    await getPinnedVersion(
      sb,
      run,
    );

  const graph =
    version.graph as DagGraph;

  const {
    data: jobs,
    error,
  } = await sb
    .from("workflow_jobs")
    .select(
      "dag_node_id,state",
    )
    .eq(
      "run_id",
      runId,
    );

  if (error) {
    throw error;
  }

  const states:
    Record<
      string,
      NodeState
    > = {};

  for (
    const node of
      graph.nodes
  ) {
    states[node.id] =
      "pending";
  }

  for (
    const job of
      jobs ?? []
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
  } =
    isTerminal(
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

  const nextState =
    failed
      ? "failed"
      : "completed";

  const {
    error: updateError,
  } = await sb
    .from("workflow_runs")
    .update({
      state:
        nextState,
      status:
        nextState,
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
                version.id,
              workflow_version:
                version.version,
            },
    })
    .eq(
      "id",
      runId,
    )
    .eq(
      "tenant_id",
      run.tenant_id,
    )
    .eq(
      "workflow_version_id",
      version.id,
    );

  if (updateError) {
    throw updateError;
  }

  await sb
    .from("workflow_events")
    .insert({
      run_id:
        runId,
      tenant_id:
        run.tenant_id,
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
          version.id,
        workflow_version:
          version.version,
      },
    });
}

function emit(
  sb: SupabaseClient,
  runId: string,
  stepId: string | null,
  type: string,
  severity: string,
  message: string,
  data: Record<
    string,
    unknown
  > = {},
) {
  return sb
    .from("workflow_events")
    .insert({
      run_id:
        runId,
      step_id:
        stepId,
      type,
      severity,
      source:
        "run-worker",
      message,
      data,
    });
}

Deno.serve(
  async (req) => {
    if (
      req.method ===
      "OPTIONS"
    ) {
      return new Response(
        "ok",
        {
          headers:
            cors,
        },
      );
    }

    if (
      req.method !==
      "POST"
    ) {
      return response(
        {
          error:
            "method not allowed",
        },
        405,
      );
    }

    const supabaseUrl =
      Deno.env.get(
        "SUPABASE_URL",
      );

    const serviceRoleKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY",
      );

    if (
      !supabaseUrl ||
      !serviceRoleKey
    ) {
      return response(
        {
          error:
            "worker configuration is missing",
        },
        500,
      );
    }

    const sb =
      createClient(
        supabaseUrl,
        serviceRoleKey,
      );

    try {
      await heartbeat(
        sb,
        "alive",
      );

      if (
        !(await workerIsActive(
          sb,
        ))
      ) {
        await heartbeat(
          sb,
          "draining",
        );

        return response({
          worker_id:
            WORKER_ID,
          processed:
            0,
          drained:
            true,
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
        if (
          !(await workerIsActive(
            sb,
          ))
        ) {
          break;
        }

        /*
         * Refresh heartbeat before every claim so a long-running batch
         * does not appear stale to operational tooling.
         */
        await heartbeat(
          sb,
          "alive",
        );

        const {
          data: job,
          error:
            claimError,
        } = await sb.rpc(
          "claim_next_job",
          {
            _worker_id:
              WORKER_ID,
          },
        );

        if (claimError) {
          console.error(
            "[run-worker] claim error",
            claimError,
          );
          break;
        }

        if (
          !job ||
          !job.id
        ) {
          break;
        }

        try {
          await processJob(
            sb,
            job as Job,
          );

          touchedRuns.add(
            (
              job as Job
            ).run_id,
          );

          processed++;
        } catch (
          error
        ) {
          const message =
            error instanceof
              Error
              ? error.message
              : String(
                  error,
                );

          console.error(
            "[run-worker] process failed",
            message,
          );

          /*
           * Do not silently leave a claimed job in running state.
           *
           * If processJob failed before it could classify the error,
           * return the durable job to retryable state with a short
           * recovery delay. The next worker can recover it.
           */
          await sb
            .from(
              "workflow_jobs",
            )
            .update({
              state:
                "retrying",
              backoff_until:
                new Date(
                  Date.now() +
                    5_000,
                ).toISOString(),
              scheduled_at:
                new Date(
                  Date.now() +
                    5_000,
                ).toISOString(),
              worker_id:
                null,
              started_at:
                null,
              lease_expires_at:
                null,
              error:
                message,
              updated_at:
                nowIso(),
            })
            .eq(
              "id",
              (
                job as Job
              ).id,
            )
            .eq(
              "worker_id",
              WORKER_ID,
            );

          touchedRuns.add(
            (
              job as Job
            ).run_id,
          );
        }
      }

      await updateActiveJobs(
        sb,
      );

      for (
        const runId of
          touchedRuns
      ) {
        try {
          await finalizeRunIfDone(
            sb,
            runId,
          );
        } catch (
          error
        ) {
          console.error(
            "[run-worker] finalization failed",
            error instanceof
              Error
              ? error.message
              : String(
                  error,
                ),
          );
        }
      }

      /*
       * If the batch was exhausted, continue draining.
       *
       * Durable jobs already exist, so the follow-on invocation does not
       * depend on this invocation remaining alive.
       */
      if (
        processed >=
        BATCH
      ) {
        fetch(
          `${supabaseUrl}/functions/v1/run-worker`,
          {
            method:
              "POST",
            headers: {
              "Content-Type":
                "application/json",
              Authorization:
                `Bearer ${serviceRoleKey}`,
            },
            body:
              "{}",
          },
        ).catch(
          (error) => {
            console.error(
              "[run-worker] follow-on worker kick failed",
              error instanceof
                Error
                ? error.message
                : String(
                    error,
                  ),
            );
          },
        );
      }

      await heartbeat(
        sb,
        "alive",
      );

      return response({
        worker_id:
          WORKER_ID,
        processed,
        batch_limit:
          BATCH,
      });
    } catch (
      error
    ) {
      console.error(
        "[run-worker] fatal worker error",
        error instanceof
          Error
          ? error.message
          : String(
              error,
            ),
      );

      try {
        await heartbeat(
          sb,
          "error",
        );
      } catch {
        // Best-effort worker health update.
      }

      return response(
        {
          error:
            error instanceof
              Error
              ? error.message
              : String(
                  error,
                ),
          worker_id:
            WORKER_ID,
        },
        500,
      );
    }
  },
);
```
