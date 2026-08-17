// supabase/functions/execute-workflow/index.ts
// Valtaris Glue — Workflow Execution Entrypoint
//
// This Edge Function is responsible for:
// - Creating workflow runs
// - Validating workflow definitions
// - Seeding initial workflow jobs
// - Emitting workflow lifecycle events
// - Handing off execution to the worker runtime
//
// It does NOT execute steps directly — that is the worker's job.
// This function simply initializes the workflow and enqueues the first job.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";

interface ExecuteWorkflowRequest {
  workflowDefinitionId: string;
  initialPayload?: Record<string, unknown>;
}

interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  steps: Array<{
    id: string;
    name: string;
    connectorKey: string;
  }>;
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadWorkflowDefinition(
  supabase: ReturnType<typeof getSupabase>,
  id: string,
): Promise<WorkflowDefinition | null> {
  const { data, error } = await supabase
    .from("workflow_definitions")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("Error loading workflow definition:", error);
    return null;
  }

  return data as WorkflowDefinition;
}

async function createWorkflowRun(
  supabase: ReturnType<typeof getSupabase>,
  definition: WorkflowDefinition,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("workflow_runs")
    .insert({
      workflow_definition_id: definition.id,
      status: "pending",
      current_step_id: definition.steps[0]?.id ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Error creating workflow run:", error);
    return null;
  }

  return data.id;
}

async function enqueueInitialJob(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
  step: WorkflowDefinition["steps"][number],
  initialPayload: Record<string, unknown> | undefined,
): Promise<boolean> {
  const now = new Date().toISOString();

  const { error } = await supabase.from("workflow_jobs").insert({
    workflow_run_id: workflowRunId,
    step_id: step.id,
    status: "queued",
    attempts: 0,
    max_attempts: 5,
    next_run_at: now,
    connector_key: step.connectorKey,
    payload: initialPayload ?? {},
  });

  if (error) {
    console.error("Error enqueuing initial job:", error);
    return false;
  }

  return true;
}

async function emitEvent(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
  kind: string,
  payload: Record<string, unknown> | null = null,
) {
  const { error } = await supabase.from("workflow_events").insert({
    workflow_run_id: workflowRunId,
    workflow_job_id: null,
    step_id: null,
    kind,
    payload,
  });

  if (error) {
    console.error("Error emitting workflow event:", error);
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: ExecuteWorkflowRequest;

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: "Invalid JSON payload",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabase = getSupabase();

  const definition = await loadWorkflowDefinition(
    supabase,
    body.workflowDefinitionId,
  );

  if (!definition) {
    return new Response(
      JSON.stringify({
        error: "Workflow definition not found",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!definition.steps || definition.steps.length === 0) {
    return new Response(
      JSON.stringify({
        error: "Workflow definition has no steps",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const workflowRunId = await createWorkflowRun(supabase, definition);

  if (!workflowRunId) {
    return new Response(
      JSON.stringify({
        error: "Failed to create workflow run",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const firstStep = definition.steps[0];

  const enqueued = await enqueueInitialJob(
    supabase,
    workflowRunId,
    firstStep,
    body.initialPayload,
  );

  if (!enqueued) {
    return new Response(
      JSON.stringify({
        error: "Failed to enqueue initial workflow job",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  await emitEvent(supabase, workflowRunId, "workflow_started", {
    workflowDefinitionId: definition.id,
    workflowRunId,
  });

  return new Response(
    JSON.stringify({
      workflowRunId,
      status: "queued",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
