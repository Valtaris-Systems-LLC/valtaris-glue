// supabase/functions/replay-workflow/index.ts
// Valtaris Glue — Workflow Replay Engine
//
// This Edge Function replays a workflow run deterministically.
// It is responsible for:
// - Validating workflow run existence
// - Resetting job state
// - Re-enqueuing initial step
// - Emitting replay events
// - Preserving lineage for auditability
//
// Replay does NOT mutate workflow definitions.
// Replay does NOT skip steps.
// Replay always starts from step 1.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";

interface ReplayRequest {
  workflowRunId: string;
  reason?: string;
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadWorkflowRun(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
) {
  const { data, error } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("id", workflowRunId)
    .single();

  if (error) {
    console.error("Error loading workflow run:", error);
    return null;
  }

  return data;
}

async function loadWorkflowDefinition(
  supabase: ReturnType<typeof getSupabase>,
  definitionId: string,
) {
  const { data, error } = await supabase
    .from("workflow_definitions")
    .select("*")
    .eq("id", definitionId)
    .single();

  if (error) {
    console.error("Error loading workflow definition:", error);
    return null;
  }

  return data;
}

async function clearExistingJobs(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
) {
  const { error } = await supabase
    .from("workflow_jobs")
    .delete()
    .eq("workflow_run_id", workflowRunId);

  if (error) {
    console.error("Error clearing workflow jobs:", error);
    return false;
  }

  return true;
}

async function enqueueInitialJob(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
  step: any,
) {
  const now = new Date().toISOString();

  const { error } = await supabase.from("workflow_jobs").insert({
    workflow_run_id: workflowRunId,
    step_id: step.id,
    status: "queued",
    attempts: 0,
    max_attempts: 5,
    next_run_at: now,
    connector_key: step.connectorKey,
    payload: {},
  });

  if (error) {
    console.error("Error enqueuing initial job:", error);
    return false;
  }

  return true;
}

async function emitReplayEvent(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
  reason: string | undefined,
) {
  const { error } = await supabase.from("workflow_events").insert({
    workflow_run_id: workflowRunId,
    workflow_job_id: null,
    step_id: null,
    kind: "workflow_replay_started",
    payload: {
      reason: reason ?? "unspecified",
      replayedAt: new Date().toISOString(),
    },
  });

  if (error) {
    console.error("Error emitting replay event:", error);
  }
}

async function resetWorkflowRunStatus(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
  firstStepId: string,
) {
  const { error } = await supabase
    .from("workflow_runs")
    .update({
      status: "pending",
      current_step_id: firstStepId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", workflowRunId);

  if (error) {
    console.error("Error resetting workflow run status:", error);
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

  let body: ReplayRequest;

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

  const definition = await loadWorkflowDefinition(
    supabase,
    run.workflow_definition_id,
  );

  if (!definition || !definition.steps || definition.steps.length === 0) {
    return new Response(
      JSON.stringify({ error: "Workflow definition invalid" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const firstStep = definition.steps[0];

  const cleared = await clearExistingJobs(supabase, run.id);
  if (!cleared) {
    return new Response(
      JSON.stringify({ error: "Failed to clear existing jobs" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const reset = await resetWorkflowRunStatus(
    supabase,
    run.id,
    firstStep.id,
  );

  if (!reset) {
    return new Response(
      JSON.stringify({ error: "Failed to reset workflow run" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const enqueued = await enqueueInitialJob(
    supabase,
    run.id,
    firstStep,
  );

  if (!enqueued) {
    return new Response(
      JSON.stringify({ error: "Failed to enqueue initial job" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  await emitReplayEvent(supabase, run.id, body.reason);

  return new Response(
    JSON.stringify({
      workflowRunId: run.id,
      status: "replay_queued",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
