// supabase/functions/rollback-executor/index.ts
// Valtaris Glue — Rollback Executor
//
// This Edge Function performs workflow rollback by executing
// compensation logic for steps that support undo operations.
//
// Responsibilities:
// - Validate workflow run existence
// - Identify completed steps
// - Execute compensation handlers
// - Emit rollback events
// - Record incidents
// - Reset workflow run status if rollback succeeds

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";

interface RollbackRequest {
  workflowRunId: string;
  reason?: string;
}

interface WorkflowStepRun {
  id: string;
  workflow_run_id: string;
  step_id: string;
  status: string;
  output: Record<string, unknown> | null;
}

interface CompensationResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadWorkflowRun(supabase: ReturnType<typeof getSupabase>, runId: string) {
  const { data, error } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (error) {
    console.error("Error loading workflow run:", error);
    return null;
  }

  return data;
}

async function loadCompletedSteps(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
): Promise<WorkflowStepRun[]> {
  const { data, error } = await supabase
    .from("workflow_step_runs")
    .select("*")
    .eq("workflow_run_id", workflowRunId)
    .eq("status", "completed");

  if (error) {
    console.error("Error loading completed steps:", error);
    return [];
  }

  return data ?? [];
}

//
// ---------------------------------------------------------------------------
// Compensation Registry
// ---------------------------------------------------------------------------
//
// In a full implementation, compensation handlers would be defined
// per connector or per workflow step. For now, we simulate a few.
//

const compensationRegistry: Record<
  string,
  (output: Record<string, unknown> | null) => Promise<CompensationResult>
> = {
  "echo": async () => {
    return { success: true };
  },

  "math.add": async () => {
    return { success: true };
  },

  "http.get": async () => {
    return { success: true };
  },
};

async function executeCompensation(
  stepId: string,
  output: Record<string, unknown> | null,
): Promise<CompensationResult> {
  const handler = compensationRegistry[stepId];

  if (!handler) {
    return {
      success: false,
      errorCode: "compensation.not_found",
      errorMessage: `No compensation handler registered for step '${stepId}'`,
    };
  }

  try {
    return await handler(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorCode: "compensation.execution_failed",
      errorMessage: message,
    };
  }
}

async function emitRollbackEvent(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
  kind: string,
  payload: Record<string, unknown>,
) {
  const { error } = await supabase.from("workflow_events").insert({
    workflow_run_id: workflowRunId,
    workflow_job_id: null,
    step_id: null,
    kind,
    payload,
  });

  if (error) {
    console.error("Error emitting rollback event:", error);
  }
}

async function recordIncident(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
  stepId: string | null,
  code: string,
  message: string,
  context: Record<string, unknown> | null = null,
) {
  const { error } = await supabase.from("workflow_incidents").insert({
    workflow_run_id: workflowRunId,
    workflow_job_id: null,
    step_id: stepId,
    severity: "warning",
    code,
    message,
    context,
  });

  if (error) {
    console.error("Error recording rollback incident:", error);
  }
}

async function resetWorkflowRun(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
) {
  const { error } = await supabase
    .from("workflow_runs")
    .update({
      status: "pending",
      updated_at: new Date().toISOString(),
    })
    .eq("id", workflowRunId);

  if (error) {
    console.error("Error resetting workflow run:", error);
    return false;
  }

  return true;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: RollbackRequest;

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON payload" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabase = getSupabase();

  const run = await loadWorkflowRun(supabase, body.workflowRunId);

  if (!run) {
    return new Response(
      JSON.stringify({ error: "Workflow run not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const completedSteps = await loadCompletedSteps(supabase, run.id);

  await emitRollbackEvent(supabase, run.id, "rollback_started", {
    reason: body.reason ?? "unspecified",
    completedSteps: completedSteps.length,
  });

  for (const stepRun of completedSteps.reverse()) {
    const result = await executeCompensation(stepRun.step_id, stepRun.output);

    if (!result.success) {
      await recordIncident(
        supabase,
        run.id,
        stepRun.step_id,
        result.errorCode ?? "compensation.error",
        result.errorMessage ?? "Compensation failed",
        { stepRunId: stepRun.id },
      );

      return new Response(
        JSON.stringify({
          workflowRunId: run.id,
          status: "rollback_failed",
          stepId: stepRun.step_id,
          error: result.errorMessage,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  await resetWorkflowRun(supabase, run.id);

  await emitRollbackEvent(supabase, run.id, "rollback_completed", {
    replayReady: true,
  });

  return new Response(
    JSON.stringify({
      workflowRunId: run.id,
      status: "rollback_completed",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
