// supabase/functions/tick-connectors/index.ts
// Valtaris Glue — Connector Tick Engine
//
// This Edge Function is responsible for:
// - Polling connectors that require periodic checks
// - Triggering workflows based on connector signals
// - Emitting connector tick events
// - Creating workflow runs when connectors produce actionable data
//
// This function is typically invoked every minute by a cron trigger.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";

interface ConnectorSchedule {
  id: string;
  connector_key: string;
  workflow_definition_id: string;
  last_tick_at: string | null;
  interval_seconds: number;
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

function shouldTick(lastTickAt: string | null, intervalSeconds: number): boolean {
  if (!lastTickAt) return true;

  const last = new Date(lastTickAt);
  const now = new Date();

  const diffMs = now.getTime() - last.getTime();
  return diffMs >= intervalSeconds * 1000;
}

async function loadConnectorSchedules(
  supabase: ReturnType<typeof getSupabase>,
): Promise<ConnectorSchedule[]> {
  const { data, error } = await supabase
    .from("connector_schedules")
    .select("*");

  if (error) {
    console.error("Error loading connector schedules:", error);
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

async function callConnector(connectorKey: string): Promise<any> {
  try {
    const res = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/connector-runner`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          connectorKey,
          payload: {},
        }),
      },
    );

    return await res.json();
  } catch (err) {
    return {
      success: false,
      errorCode: "connector.tick_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
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
  payload: Record<string, unknown>,
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
    payload,
  });

  if (error) {
    console.error("Error enqueuing initial job:", error);
    return false;
  }

  return true;
}

async function updateLastTick(
  supabase: ReturnType<typeof getSupabase>,
  scheduleId: string,
) {
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("connector_schedules")
    .update({ last_tick_at: now })
    .eq("id", scheduleId);

  if (error) {
    console.error("Error updating last_tick_at:", error);
  }
}

async function emitConnectorEvent(
  supabase: ReturnType<typeof getSupabase>,
  workflowRunId: string | null,
  scheduleId: string,
  connectorKey: string,
  payload: Record<string, unknown>,
) {
  const { error } = await supabase.from("workflow_events").insert({
    workflow_run_id: workflowRunId,
    workflow_job_id: null,
    step_id: null,
    kind: "connector_tick",
    payload: {
      scheduleId,
      connectorKey,
      tickedAt: new Date().toISOString(),
      connectorPayload: payload,
    },
  });

  if (error) {
    console.error("Error emitting connector tick event:", error);
  }
}

serve(async () => {
  const supabase = getSupabase();

  const schedules = await loadConnectorSchedules(supabase);

  const triggered: Array<{ scheduleId: string; workflowRunId: string | null }> = [];

  for (const schedule of schedules) {
    if (!shouldTick(schedule.last_tick_at, schedule.interval_seconds)) {
      continue;
    }

    const connectorResult = await callConnector(schedule.connector_key);

    await updateLastTick(supabase, schedule.id);

    if (!connectorResult.success) {
      await emitConnectorEvent(
        supabase,
        null,
        schedule.id,
        schedule.connector_key,
        connectorResult,
      );
      continue;
    }

    const definition = await loadWorkflowDefinition(
      supabase,
      schedule.workflow_definition_id,
    );

    if (!definition || !definition.steps || definition.steps.length === 0) {
      console.error("Invalid workflow definition for connector schedule:", schedule.id);
      continue;
    }

    const workflowRunId = await createWorkflowRun(supabase, definition);
    if (!workflowRunId) continue;

    const firstStep = definition.steps[0];

    const enqueued = await enqueueInitialJob(
      supabase,
      workflowRunId,
      firstStep,
      connectorResult.output ?? {},
    );

    if (!enqueued) continue;

    await emitConnectorEvent(
      supabase,
      workflowRunId,
      schedule.id,
      schedule.connector_key,
      connectorResult.output ?? {},
    );

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
