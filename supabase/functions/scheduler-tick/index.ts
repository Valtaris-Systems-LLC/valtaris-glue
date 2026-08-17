// supabase/functions/scheduler-tick/index.ts
// Valtaris Glue — Scheduler Tick Engine
//
// This Edge Function is responsible for:
// - Scanning scheduled workflow definitions
// - Determining which workflows should run now
// - Creating workflow runs for due schedules
// - Seeding initial jobs
// - Emitting scheduler events
//
// This function is typically invoked every minute by a cron trigger.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";

interface ScheduledWorkflow {
  id: string;
  workflow_definition_id: string;
  cron: string;
  last_run_at: string | null;
}

interface WorkflowDefinition {
  id: string;
  steps: Array<{
    id: string;
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

function shouldRun(cron: string, lastRunAt: string | null): boolean {
  // Minimal cron evaluator: run every minute
  // You can replace this with a full cron parser later.
  if (!lastRunAt) return true;

  const last = new Date(lastRunAt);
  const now = new Date();

  const diffMs = now.getTime() - last.getTime();
  return diffMs >= 60_000; // 1 minute
}

async function loadScheduledWorkflows(
  supabase: ReturnType<typeof getSupabase>,
): Promise<ScheduledWorkflow[]> {
  const { data, error } = await supabase
    .from("workflow_schedules")
    .select("*");

  if (error) {
    console.error("Error loading scheduled workflows:", error);
    return [];
  }

  return data ?? [];
}

async function loadWorkflowDefinition(
  supabase: ReturnType<typeof getSupabase>,
  definitionId: string,
): Promise<WorkflowDefinition | null> {
  const { data, error } = await supabase
    .from("workflow_definitions")
    .select("*")
    .eq("id", definitionId)
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
    payload: {},
  });

  if (error) {
    console.error("Error enqueuing initial job:", error);
    return false;
  }

  return true;
}

async function updateLastRun(
  supabase: ReturnType<typeof getSupabase>,
  scheduleId: string,
) {
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("workflow_schedules")
    .update({ last_run_at: now })
    .eq("id", scheduleId);

  if (error) {
    console.error("Error updating last_run_at:", error);
  }
}

async function emitSchedulerEvent(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string,
  scheduleId: string,
) {
  const { error } = await supabase.from("workflow_events").insert({
    workflow_run_id: workflowRunId,
    workflow_job_id: null,
    step_id: null,
    kind: "scheduler_triggered",
    payload: {
      scheduleId,
      triggeredAt: new Date().toISOString(),
    },
  });

  if (error) {
    console.error("Error emitting scheduler event:", error);
  }
}

serve(async () => {
  const supabase = getSupabase();

  const schedules = await loadScheduledWorkflows(supabase);

  const triggered: Array<{ scheduleId: string; workflowRunId: string }> = [];

  for (const schedule of schedules) {
    if (!shouldRun(schedule.cron, schedule.last_run_at)) {
      continue;
    }

    const definition = await loadWorkflowDefinition(
      supabase,
      schedule.workflow_definition_id,
    );

    if (!definition || !definition.steps || definition.steps.length === 0) {
      console.error("Invalid workflow definition for schedule:", schedule.id);
      continue;
    }

    const workflowRunId = await createWorkflowRun(supabase, definition);
    if (!workflowRunId) continue;

    const firstStep = definition.steps[0];
    const enqueued = await enqueueInitialJob(
      supabase,
      workflowRunId,
      firstStep,
    );

    if (!enqueued) continue;

    await updateLastRun(supabase, schedule.id);
    await emitSchedulerEvent(supabase, workflowRunId, schedule.id);

    triggered.push({ scheduleId: schedule.id, workflowRunId });
  }

  return new Response(
    JSON.stringify({
      triggeredCount: triggered.length,
      triggered,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
