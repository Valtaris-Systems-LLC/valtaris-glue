// Deterministic observational replay engine.
//
// Replay NEVER invokes external connectors.
//
// Instead it reconstructs the source execution from its persisted
// workflow version, step runs, and checkpoints. This makes replay:
//   - deterministic
//   - side-effect free
//   - tied to the exact workflow version used by the source run
//   - useful for audit / forensic inspection
//
// The replay run receives its own workflow_run record and its own
// workflow_step_runs / workflow_checkpoints records, while retaining
// explicit provenance back to the original run.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireUser, logSecurity } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface SourceRun {
  id: string;
  tenant_id: string | null;
  workflow_id: string | null;
  workflow_name: string;
  workflow_version_id: string | null;
  correlation_id: string | null;
  payload: Record<string, unknown> | null;
  state: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface WorkflowVersion {
  id: string;
  definition_id: string | null;
  version: number | string | null;
  state: string;
  graph: Record<string, unknown> | null;
}

interface SourceStep {
  id: string;
  run_id: string;
  step_index: number;
  dag_node_id: string | null;
  name: string | null;
  connector: string | null;
  state: string;
  attempt: number | null;
  retry_count: number | null;
  idempotency_key: string | null;
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  connector_response: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
}

interface SourceCheckpoint {
  id: string;
  run_id: string;
  step_index: number;
  workflow_version_id: string | null;
  snapshot: Record<string, unknown> | null;
  created_at: string | null;
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

function cloneJson<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return response({ error: "method not allowed" }, 405);
  }

  const auth = await requireUser(req);

  if (!auth.ok) {
    return response({ error: auth.error }, auth.status);
  }

  const operatorUid = auth.ctx.userId;

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, key);

  try {
    const body = await req.json().catch(() => ({}));

    const sourceRunId =
      typeof body.source_run_id === "string"
        ? body.source_run_id.trim()
        : "";

    if (!sourceRunId) {
      return response(
        { error: "source_run_id required" },
        400,
      );
    }

    /*
     * ------------------------------------------------------------
     * 1. Load the source run.
     * ------------------------------------------------------------
     */

    const { data: source, error: sourceErr } = await sb
      .from("workflow_runs")
      .select(
        [
          "id",
          "tenant_id",
          "workflow_id",
          "workflow_name",
          "workflow_version_id",
          "correlation_id",
          "payload",
          "state",
          "status",
          "started_at",
          "ended_at",
        ].join(","),
      )
      .eq("id", sourceRunId)
      .single();

    if (sourceErr) {
      throw sourceErr;
    }

    if (!source) {
      return response(
        { error: "source run not found" },
        404,
      );
    }

    const sourceRun = source as SourceRun;

    /*
     * ------------------------------------------------------------
     * 2. Tenant authorization.
     * ------------------------------------------------------------
     */

    const { data: allowed, error: accessErr } = await sb.rpc(
      "has_tenant_access",
      {
        _uid: operatorUid,
        _tenant_id: sourceRun.tenant_id,
      },
    );

    if (accessErr) {
      throw accessErr;
    }

    if (!allowed) {
      await logSecurity({
        tenant_id: sourceRun.tenant_id,
        actor_user_id: operatorUid,
        category: "authz.denied",
        severity: "warn",
        subject_type: "run",
        subject_id: sourceRunId,
        message:
          "replay denied: caller not a tenant member",
      });

      return response(
        { error: "forbidden" },
        403,
      );
    }

    /*
     * ------------------------------------------------------------
     * 3. A replay must have version provenance.
     *
     * New runs created by the updated execution path have a pinned
     * workflow_version_id.
     *
     * Legacy runs without one are intentionally rejected rather
     * than silently replaying against today's workflow definition.
     * ------------------------------------------------------------
     */

    if (!sourceRun.workflow_version_id) {
      await logSecurity({
        tenant_id: sourceRun.tenant_id,
        actor_user_id: operatorUid,
        category: "replay.rejected",
        severity: "warn",
        subject_type: "run",
        subject_id: sourceRunId,
        message:
          "replay rejected: source run has no immutable workflow version",
      });

      return response(
        {
          error:
            "source run has no workflow_version_id; legacy runs cannot be safely replayed",
        },
        409,
      );
    }

    /*
     * ------------------------------------------------------------
     * 4. Load the exact immutable workflow version.
     * ------------------------------------------------------------
     */

    const { data: version, error: versionErr } = await sb
      .from("workflow_versions")
      .select(
        "id,definition_id,version,state,graph",
      )
      .eq("id", sourceRun.workflow_version_id)
      .single();

    if (versionErr) {
      throw versionErr;
    }

    if (!version) {
      return response(
        {
          error:
            "source workflow version not found",
          workflow_version_id:
            sourceRun.workflow_version_id,
        },
        404,
      );
    }

    const workflowVersion =
      version as WorkflowVersion;

    if (
      workflowVersion.state !== "published"
    ) {
      return response(
        {
          error:
            "source workflow version is not published",
          workflow_version_id:
            workflowVersion.id,
          state: workflowVersion.state,
        },
        409,
      );
    }

    /*
     * ------------------------------------------------------------
     * 5. Load persisted execution evidence.
     * ------------------------------------------------------------
     */

    const { data: rawSteps, error: stepsErr } =
      await sb
        .from("workflow_step_runs")
        .select(
          [
            "id",
            "run_id",
            "step_index",
            "dag_node_id",
            "name",
            "connector",
            "state",
            "attempt",
            "retry_count",
            "idempotency_key",
            "inputs",
            "outputs",
            "connector_response",
            "result",
            "error",
            "duration_ms",
            "started_at",
            "ended_at",
          ].join(","),
        )
        .eq("run_id", sourceRunId)
        .order("step_index", {
          ascending: true,
        });

    if (stepsErr) {
      throw stepsErr;
    }

    const steps =
      (rawSteps ?? []) as SourceStep[];

    const { data: rawCheckpoints, error: checkpointErr } =
      await sb
        .from("workflow_checkpoints")
        .select(
          [
            "id",
            "run_id",
            "step_index",
            "workflow_version_id",
            "snapshot",
            "created_at",
          ].join(","),
        )
        .eq("run_id", sourceRunId)
        .order("step_index", {
          ascending: true,
        });

    if (checkpointErr) {
      throw checkpointErr;
    }

    const checkpoints =
      (rawCheckpoints ?? []) as SourceCheckpoint[];

    /*
     * A checkpoint from another workflow version must never be used
     * to reconstruct this run.
     */
    const mismatchedCheckpoint =
      checkpoints.find(
        (checkpoint) =>
          checkpoint.workflow_version_id &&
          checkpoint.workflow_version_id !==
            workflowVersion.id,
      );

    if (mismatchedCheckpoint) {
      return response(
        {
          error:
            "source run contains a checkpoint from a different workflow version",
          checkpoint_id:
            mismatchedCheckpoint.id,
          checkpoint_workflow_version_id:
            mismatchedCheckpoint.workflow_version_id,
          workflow_version_id:
            workflowVersion.id,
        },
        409,
      );
    }

    /*
     * ------------------------------------------------------------
     * 6. Determine the reconstruction boundary.
     *
     * The latest valid checkpoint is the last persisted execution
     * boundary. Everything at or before that point is reconstructed
     * from checkpoint/step evidence. Everything after it is also
     * reconstructed from source execution evidence.
     *
     * There is deliberately NO "resume and execute connectors" mode.
     * Replay is observational.
     * ------------------------------------------------------------
     */

    const latestCheckpoint =
      checkpoints.length > 0
        ? checkpoints[checkpoints.length - 1]
        : null;

    const resumeFrom =
      latestCheckpoint
        ? latestCheckpoint.step_index + 1
        : 0;

    const correlationId =
      sourceRun.correlation_id ??
      crypto.randomUUID();

    /*
     * ------------------------------------------------------------
     * 7. Create the replay run with complete provenance.
     * ------------------------------------------------------------
     */

    const replayPayload = {
      ...(sourceRun.payload ?? {}),
      replay: true,
      replay_mode: "observational",
      replay_of: sourceRunId,
      source_workflow_version_id:
        workflowVersion.id,
      source_definition_id:
        workflowVersion.definition_id,
      source_version:
        workflowVersion.version,
      resume_from: resumeFrom,
      initiated_by: operatorUid,
    };

    const { data: replayRun, error: replayRunErr } =
      await sb
        .from("workflow_runs")
        .insert({
          tenant_id: sourceRun.tenant_id,
          workflow_name:
            `${sourceRun.workflow_name} · replay`,
          workflow_id:
            sourceRun.workflow_id ??
            workflowVersion.definition_id,
          workflow_version_id:
            workflowVersion.id,
          state: "replaying",
          status: "replaying",
          correlation_id: correlationId,
          payload: replayPayload,
          started_at:
            new Date().toISOString(),
        })
        .select(
          "id,workflow_version_id,tenant_id",
        )
        .single();

    if (replayRunErr) {
      throw replayRunErr;
    }

    if (!replayRun) {
      throw new Error(
        "failed to create replay run",
      );
    }

    const replayRunId =
      replayRun.id as string;

    /*
     * ------------------------------------------------------------
     * 8. Emit replay provenance.
     * ------------------------------------------------------------
     */

    const emit = (
      type: string,
      severity: string,
      message: string,
      data: Record<string, unknown> = {},
      stepId: string | null = null,
    ) =>
      sb.from("workflow_events").insert({
        run_id: replayRunId,
        step_id: stepId,
        type,
        severity,
        source: "replay-workflow",
        message,
        data: {
          ...data,
          replay: true,
          replay_mode: "observational",
          source_run_id: sourceRunId,
          source_workflow_version_id:
            workflowVersion.id,
        },
      });

    await emit(
      "replay.started",
      "info",
      `Observational replay of ${sourceRun.workflow_name}`,
      {
        source_run_id: sourceRunId,
        workflow_version_id:
          workflowVersion.id,
        definition_id:
          workflowVersion.definition_id,
        version:
          workflowVersion.version,
        resume_from: resumeFrom,
        source_steps: steps.length,
        source_checkpoints:
          checkpoints.length,
      },
    );

    /*
     * ------------------------------------------------------------
     * 9. Reconstruct source execution.
     *
     * We process persisted source step records in deterministic
     * step_index order.
     *
     * No sleeps.
     * No Math.random().
     * No connector invocation.
     * No generated failure.
     *
     * Every replayed step points back to the source step through
     * metadata in the replay payload/result.
     * ------------------------------------------------------------
     */

    const replayStartedAt =
      new Date().toISOString();

    let replayFailed = false;
    let replayFailureMessage:
      | string
      | null = null;

    for (const sourceStep of steps) {
      /*
       * Preserve the original source state as evidence.
       *
       * A failed/dead-lettered source step remains failed in the
       * observational replay. We do not fabricate a successful
       * outcome that never occurred.
       */
      const sourceState =
        sourceStep.state;

      const replayState =
        sourceState === "completed"
          ? "completed"
          : sourceState === "failed" ||
              sourceState ===
                "dead_letter"
            ? "failed"
            : sourceState ===
                "cancelled"
              ? "cancelled"
              : "replayed";

      const sourceResult =
        sourceStep.result ??
        sourceStep.outputs ??
        sourceStep.connector_response ??
        null;

      const replayResult = {
        replayed: true,
        replay_mode: "observational",
        source_step_id:
          sourceStep.id,
        source_run_id: sourceRunId,
        source_state: sourceState,
        source_attempt:
          sourceStep.attempt,
        source_retry_count:
          sourceStep.retry_count,
        source_idempotency_key:
          sourceStep.idempotency_key,
        source_result:
          cloneJson(sourceResult),
      };

      const replayInputs =
        cloneJson(
          sourceStep.inputs ??
            sourceRun.payload ??
            {},
        );

      const now =
        new Date().toISOString();

      const { data: replayStep, error: replayStepErr } =
        await sb
          .from("workflow_step_runs")
          .insert({
            run_id: replayRunId,
            step_index:
              sourceStep.step_index,
            dag_node_id:
              sourceStep.dag_node_id,
            name: sourceStep.name,
            connector:
              sourceStep.connector,
            state: replayState,
            started_at:
              sourceStep.started_at ??
              now,
            ended_at:
              sourceStep.ended_at ??
              now,
            duration_ms:
              sourceStep.duration_ms ??
              0,
            attempt:
              sourceStep.attempt ?? 1,
            retry_count:
              sourceStep.retry_count ?? 0,
            inputs: replayInputs,
            outputs:
              cloneJson(
                sourceStep.outputs,
              ),
            connector_response:
              cloneJson(
                sourceStep.connector_response,
              ),
            result: replayResult,
            error:
              sourceStep.error ??
              null,
            idempotency_key:
              `replay:${replayRunId}:${sourceStep.step_index}`,
          })
          .select("id")
          .single();

      if (replayStepErr) {
        throw replayStepErr;
      }

      const replayStepId =
        replayStep?.id ?? null;

      await emit(
        "step.replayed",
        sourceState ===
            "completed"
          ? "info"
          : "warn",
        sourceState ===
            "completed"
          ? `↺ ${sourceStep.name ?? `step ${sourceStep.step_index}`} reconstructed`
          : `↺ ${sourceStep.name ?? `step ${sourceStep.step_index}`} reconstructed with source state ${sourceState}`,
        {
          index:
            sourceStep.step_index,
          connector:
            sourceStep.connector,
          source_step_id:
            sourceStep.id,
          source_state:
            sourceState,
          duration_ms:
            sourceStep.duration_ms ??
            0,
          checkpointed:
            sourceStep.step_index <
            resumeFrom,
        },
        replayStepId,
      );

      /*
       * Recreate a replay checkpoint from the source checkpoint
       * when one exists. Otherwise construct a deterministic
       * checkpoint from the persisted source step evidence.
       */
      const sourceCheckpoint =
        checkpoints.find(
          (checkpoint) =>
            checkpoint.step_index ===
            sourceStep.step_index,
        );

      const checkpointSnapshot =
        sourceCheckpoint?.snapshot ??
        {
          node_id:
            sourceStep.dag_node_id,
          name:
            sourceStep.name,
          connector:
            sourceStep.connector,
          inputs:
            cloneJson(
              sourceStep.inputs,
            ),
          outputs:
            cloneJson(
              sourceResult,
            ),
          source_step_id:
            sourceStep.id,
          source_state:
            sourceState,
        };

      const { error: replayCheckpointErr } =
        await sb
          .from("workflow_checkpoints")
          .insert({
            run_id: replayRunId,
            workflow_version_id:
              workflowVersion.id,
            step_index:
              sourceStep.step_index,
            snapshot: {
              ...cloneJson(
                checkpointSnapshot,
              ),
              replay: true,
              replay_mode:
                "observational",
              source_run_id:
                sourceRunId,
              source_step_id:
                sourceStep.id,
              source_workflow_version_id:
                workflowVersion.id,
            },
          });

      if (replayCheckpointErr) {
        throw replayCheckpointErr;
      }

      if (
        sourceState ===
          "failed" ||
        sourceState ===
          "dead_letter"
      ) {
        replayFailed = true;
        replayFailureMessage =
          sourceStep.error ??
          `Source step ${sourceStep.name ?? sourceStep.step_index} failed`;
      }
    }

    /*
     * ------------------------------------------------------------
     * 10. Finalize replay.
     * ------------------------------------------------------------
     */

    const replayEndedAt =
      new Date().toISOString();

    const durationMs =
      sourceRun.started_at &&
      sourceRun.ended_at
        ? Math.max(
            0,
            new Date(
              sourceRun.ended_at,
            ).getTime() -
              new Date(
                sourceRun.started_at,
              ).getTime(),
          )
        : 0;

    const finalState =
      replayFailed
        ? "failed"
        : "completed";

    const finalResult = {
      replayed_of:
        sourceRunId,
      replay_mode:
        "observational",
      source_workflow_version_id:
        workflowVersion.id,
      source_definition_id:
        workflowVersion.definition_id,
      source_version:
        workflowVersion.version,
      source_step_count:
        steps.length,
      source_checkpoint_count:
        checkpoints.length,
      resume_from:
        resumeFrom,
      deterministic:
        true,
      external_side_effects:
        false,
      replay_started_at:
        replayStartedAt,
      replay_ended_at:
        replayEndedAt,
    };

    const { error: finalizeErr } =
      await sb
        .from("workflow_runs")
        .update({
          state: finalState,
          status: finalState,
          ended_at: replayEndedAt,
          duration_ms: durationMs,
          result:
            replayFailed
              ? null
              : finalResult,
          error:
            replayFailureMessage,
        })
        .eq("id", replayRunId);

    if (finalizeErr) {
      throw finalizeErr;
    }

    await emit(
      replayFailed
        ? "replay.failed"
        : "replay.completed",
      replayFailed
        ? "error"
        : "info",
      replayFailed
        ? `Observational replay reconstructed source failure`
        : `Observational replay completed deterministically`,
      {
        duration_ms:
          durationMs,
        source_run_id:
          sourceRunId,
        workflow_version_id:
          workflowVersion.id,
        deterministic:
          true,
        external_side_effects:
          false,
        error:
          replayFailureMessage,
      },
    );

    await logSecurity({
      tenant_id:
        sourceRun.tenant_id,
      actor_user_id:
        operatorUid,
      category:
        replayFailed
          ? "replay.failed"
          : "replay.completed",
      severity:
        replayFailed
          ? "warn"
          : "info",
      subject_type:
        "run",
      subject_id:
        replayRunId,
      message:
        replayFailed
          ? "observational replay reconstructed a source failure"
          : "observational replay completed",
      details: {
        source_run_id:
          sourceRunId,
        workflow_version_id:
          workflowVersion.id,
        deterministic:
          true,
        external_side_effects:
          false,
      },
    });

    return response(
      {
        run_id:
          replayRunId,
        source_run_id:
          sourceRunId,
        workflow_version_id:
          workflowVersion.id,
        replay_mode:
          "observational",
        deterministic:
          true,
        external_side_effects:
          false,
        resume_from:
          resumeFrom,
        replayed_steps:
          steps.length,
        replayed_checkpoints:
          checkpoints.length,
        state:
          finalState,
      },
      202,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "[replay-workflow] error",
      message,
    );

    return response(
      { error: message },
      500,
    );
  }
});
