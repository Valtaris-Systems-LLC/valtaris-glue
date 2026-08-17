import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireUser, logSecurity } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface RollbackRequest {
  run_id?: string;
  reason?: string;
}

interface WorkflowRun {
  id: string;
  tenant_id: string | null;
  workflow_name: string;
  workflow_version_id: string | null;
  state: string | null;
  status: string | null;
}

interface StepRun {
  id: string;
  step_index: number;
  dag_node_id: string | null;
  name: string | null;
  connector: string | null;
  state: string;
  outputs: Record<string, unknown> | null;
  connector_response: Record<string, unknown> | null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

function compensationIdempotencyKey(
  runId: string,
  stepId: string,
) {
  return `rollback:${runId}:${stepId}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const auth = await requireUser(req);

  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  const operatorUid = auth.ctx.userId;

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get(
    "SUPABASE_SERVICE_ROLE_KEY",
  )!;

  const sb = createClient(
    url,
    serviceKey,
  );

  try {
    const body =
      (await req.json().catch(
        () => ({}),
      )) as RollbackRequest;

    const runId =
      typeof body.run_id === "string"
        ? body.run_id.trim()
        : "";

    const reason =
      typeof body.reason === "string" &&
      body.reason.trim()
        ? body.reason.trim()
        : "Manual rollback requested";

    if (!runId) {
      return json(
        { error: "run_id required" },
        400,
      );
    }

    /*
     * ------------------------------------------------------------
     * 1. Resolve the target run before authorizing the operation.
     * ------------------------------------------------------------
     */

    const { data: run, error: runErr } =
      await sb
        .from("workflow_runs")
        .select(
          [
            "id",
            "tenant_id",
            "workflow_name",
            "workflow_version_id",
            "state",
            "status",
          ].join(","),
        )
        .eq("id", runId)
        .single();

    if (runErr) {
      throw runErr;
    }

    if (!run) {
      return json(
        { error: "workflow run not found" },
        404,
      );
    }

    const workflowRun =
      run as WorkflowRun;

    /*
     * ------------------------------------------------------------
     * 2. Authorize the authenticated operator.
     *
     * Rollback is a privileged side-effecting operation. Do not
     * trust triggered_by from the request body.
     * ------------------------------------------------------------
     */

    const { data: allowed, error: accessErr } =
      await sb.rpc(
        "has_operator_role",
        {
          _uid: operatorUid,
          _tenant_id:
            workflowRun.tenant_id,
          _required: "operator",
        },
      );

    if (accessErr) {
      throw accessErr;
    }

    if (!allowed) {
      await logSecurity({
        tenant_id:
          workflowRun.tenant_id,
        actor_user_id:
          operatorUid,
        category:
          "authz.denied",
        severity:
          "warn",
        subject_type:
          "workflow_run",
        subject_id:
          runId,
        message:
          "rollback denied: operator role required",
        details: {
          workflow_version_id:
            workflowRun.workflow_version_id,
        },
      });

      return json(
        { error: "forbidden" },
        403,
      );
    }

    /*
     * ------------------------------------------------------------
     * 3. Validate the target state.
     *
     * A completed run is the normal rollback target. A failed or
     * partially completed run may also be compensatable. A run that
     * has not begun execution has nothing to compensate.
     * ------------------------------------------------------------
     */

    const state =
      workflowRun.state ??
      workflowRun.status ??
      "";

    if (
      state === "queued" ||
      state === "pending" ||
      state === "created"
    ) {
      return json(
        {
          error:
            "workflow run has not executed any steps",
          run_id: runId,
          state,
        },
        409,
      );
    }

    /*
     * ------------------------------------------------------------
     * 4. Load only completed steps.
     *
     * Compensation proceeds in reverse execution order.
     * ------------------------------------------------------------
     */

    const { data: rawSteps, error: stepsErr } =
      await sb
        .from("workflow_step_runs")
        .select(
          [
            "id",
            "step_index",
            "dag_node_id",
            "name",
            "connector",
            "state",
            "outputs",
            "connector_response",
          ].join(","),
        )
        .eq("run_id", runId)
        .eq("state", "completed")
        .order("step_index", {
          ascending: false,
        });

    if (stepsErr) {
      throw stepsErr;
    }

    const steps =
      (rawSteps ??
        []) as StepRun[];

    /*
     * ------------------------------------------------------------
     * 5. Establish rollback state before executing compensation.
     * ------------------------------------------------------------
     */

    const { error: markErr } =
      await sb
        .from("workflow_runs")
        .update({
          state: "rolling_back",
          status: "rolling_back",
          rollback_reason: reason,
          rollback_started_at:
            new Date().toISOString(),
        })
        .eq("id", runId)
        .eq("tenant_id", workflowRun.tenant_id);

    if (markErr) {
      throw markErr;
    }

    await sb
      .from("workflow_events")
      .insert({
        run_id: runId,
        type: "rollback.started",
        severity: "warn",
        source: "rollback-executor",
        message:
          `Rollback initiated by operator ${operatorUid}`,
        data: {
          reason,
          actor_user_id:
            operatorUid,
          workflow_version_id:
            workflowRun.workflow_version_id,
          completed_steps:
            steps.length,
        },
      });

    /*
     * ------------------------------------------------------------
     * 6. Compensate in reverse order.
     *
     * The existing connector contract is intentionally preserved:
     * compensation is represented as a connector operation rather
     * than invoking the normal forward execution path.
     * ------------------------------------------------------------
     */

    let compensated = 0;
    let alreadyCompensated = 0;
    let failed = 0;

    for (const step of steps) {
      const idempotencyKey =
        compensationIdempotencyKey(
          runId,
          step.id,
        );

      /*
       * Idempotency guard.
       *
       * If this compensation already produced a terminal result,
       * do not execute it again.
       */
      const { data: existing } =
        await sb
          .from("rollback_actions")
          .select(
            "id,state,result,error",
          )
          .eq(
            "idempotency_key",
            idempotencyKey,
          )
          .maybeSingle();

      if (
        existing?.state ===
          "completed"
      ) {
        alreadyCompensated++;
        continue;
      }

      /*
       * Reserve the compensation action before invoking the external
       * side effect. The unique idempotency key prevents duplicate
       * rollback rows under concurrent/repeated requests.
       */
      const { data: action, error: actionErr } =
        await sb
          .from("rollback_actions")
          .upsert(
            {
              run_id: runId,
              step_run_id: step.id,
              dag_node_id:
                step.dag_node_id,
              connector:
                step.connector,
              state: "running",
              idempotency_key:
                idempotencyKey,
              requested_by:
                operatorUid,
              reason,
              started_at:
                new Date().toISOString(),
            },
            {
              onConflict:
                "idempotency_key",
            },
          )
          .select(
            "id,state",
          )
          .single();

      if (actionErr) {
        throw actionErr;
      }

      if (
        action?.state ===
          "completed"
      ) {
        alreadyCompensated++;
        continue;
      }

      /*
       * Compensation is deliberately explicit.
       *
       * Glue connectors may expose a compensating operation through
       * their connector implementation. If a connector has no
       * compensation contract, fail closed rather than pretending
       * rollback succeeded.
       */
      let compensationResult:
        | Record<string, unknown>
        | null = null;

      try {
        const connector =
          step.connector ??
          "unknown";

        /*
         * The connector compensation endpoint/function is resolved
         * through the shared connector registry. This keeps rollback
         * behavior separate from normal forward execution.
         */
        const connectorModule =
          await import(
            `../_shared/connectors.ts`
          );

        const getCompensator =
          (
            connectorModule as {
              getCompensator?: (
                connector: string,
              ) => {
                compensate: (
                  context: Record<
                    string,
                    unknown
                  >,
                ) => Promise<{
                  ok: boolean;
                  data?: Record<
                    string,
                    unknown
                  >;
                  error?: string;
                }>;
              } | null;
            }
          ).getCompensator;

        if (
          typeof getCompensator !==
          "function"
        ) {
          throw new Error(
            `connector ${connector} does not expose a compensation contract`,
          );
        }

        const compensator =
          getCompensator(
            connector,
          );

        if (!compensator) {
          throw new Error(
            `connector ${connector} does not support compensation`,
          );
        }

        const result =
          await compensator.compensate({
            run_id: runId,
            step_run_id:
              step.id,
            dag_node_id:
              step.dag_node_id,
            workflow_version_id:
              workflowRun.workflow_version_id,
            idempotency_key:
              idempotencyKey,
            original_outputs:
              step.outputs ?? {},
            connector_response:
              step.connector_response ??
              {},
            requested_by:
              operatorUid,
            reason,
          });

        if (!result.ok) {
          throw new Error(
            result.error ??
              `compensation failed for ${step.name ?? step.id}`,
          );
        }

        compensationResult =
          result.data ?? {};
      } catch (error) {
        failed++;

        const errorMessage =
          error instanceof Error
            ? error.message
            : String(error);

        await sb
          .from("rollback_actions")
          .update({
            state: "failed",
            error:
              errorMessage,
            ended_at:
              new Date().toISOString(),
          })
          .eq(
            "idempotency_key",
            idempotencyKey,
          );

        await sb
          .from("workflow_events")
          .insert({
            run_id: runId,
            type:
              "rollback.step_failed",
            severity: "error",
            source:
              "rollback-executor",
            message:
              `Compensation failed for ${step.name ?? step.id}`,
            data: {
              step_run_id:
                step.id,
              connector:
                step.connector,
              idempotency_key:
                idempotencyKey,
              error:
                errorMessage,
            },
          });

        /*
         * Fail closed. Do not continue compensating later steps after
         * an earlier compensation has failed, because the resulting
         * external state may no longer match the expected reverse-order
         * compensation sequence.
         */
        break;
      }

      await sb
        .from("rollback_actions")
        .update({
          state: "completed",
          result:
            compensationResult,
          ended_at:
            new Date().toISOString(),
        })
        .eq(
          "idempotency_key",
          idempotencyKey,
        );

      compensated++;

      await sb
        .from("workflow_events")
        .insert({
          run_id: runId,
          type:
            "rollback.step_completed",
          severity: "info",
          source:
            "rollback-executor",
          message:
            `Compensated ${step.name ?? step.id}`,
          data: {
            step_run_id:
              step.id,
            connector:
              step.connector,
            idempotency_key:
              idempotencyKey,
            workflow_version_id:
              workflowRun.workflow_version_id,
          },
        });
    }

    /*
     * ------------------------------------------------------------
     * 7. Finalize rollback state.
     * ------------------------------------------------------------
     */

    const rollbackFailed =
      failed > 0;

    const finalState =
      rollbackFailed
        ? "rollback_failed"
        : "rolled_back";

    const endedAt =
      new Date().toISOString();

    const { error: finalizeErr } =
      await sb
        .from("workflow_runs")
        .update({
          state: finalState,
          status: finalState,
          rollback_ended_at:
            endedAt,
          rollback_result: {
            actor_user_id:
              operatorUid,
            reason,
            compensated,
            already_compensated:
              alreadyCompensated,
            failed,
            workflow_version_id:
              workflowRun.workflow_version_id,
          },
        })
        .eq("id", runId)
        .eq(
          "tenant_id",
          workflowRun.tenant_id,
        );

    if (finalizeErr) {
      throw finalizeErr;
    }

    await sb
      .from("workflow_events")
      .insert({
        run_id: runId,
        type:
          rollbackFailed
            ? "rollback.failed"
            : "rollback.completed",
        severity:
          rollbackFailed
            ? "error"
            : "warn",
        source:
          "rollback-executor",
        message:
          rollbackFailed
            ? "Rollback failed before all compensations completed"
            : "Rollback completed",
        data: {
          actor_user_id:
            operatorUid,
          reason,
          compensated,
          already_compensated:
            alreadyCompensated,
          failed,
          workflow_version_id:
            workflowRun.workflow_version_id,
        },
      });

    await logSecurity({
      tenant_id:
        workflowRun.tenant_id,
      actor_user_id:
        operatorUid,
      category:
        rollbackFailed
          ? "rollback.failed"
          : "rollback.completed",
      severity:
        rollbackFailed
          ? "error"
          : "warn",
      subject_type:
        "workflow_run",
      subject_id:
        runId,
      message:
        rollbackFailed
          ? "workflow rollback failed"
          : "workflow rollback completed",
      details: {
        reason,
        compensated,
        already_compensated:
          alreadyCompensated,
        failed,
        workflow_version_id:
          workflowRun.workflow_version_id,
      },
    });

    return json(
      {
        run_id: runId,
        state: finalState,
        workflow_version_id:
          workflowRun.workflow_version_id,
        compensated,
        already_compensated:
          alreadyCompensated,
        failed,
        actor_user_id:
          operatorUid,
      },
      rollbackFailed
        ? 409
        : 200,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "[rollback-executor] error",
      message,
    );

    return json(
      { error: message },
      500,
    );
  }
});
