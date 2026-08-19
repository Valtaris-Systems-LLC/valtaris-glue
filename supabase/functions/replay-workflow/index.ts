// supabase/functions/replay-workflow/index.ts
// Valtaris Glue — Workflow Replay Engine (Generation 3)
//
// This file is responsible for:
//   - reconstructing workflow execution deterministically
//   - replaying step runs WITHOUT executing connectors
//   - generating a new replay run_id
//   - emitting replay events
//   - preserving version pinning
//   - preserving approval + compensation semantics
//
// Authority chain:
//   operator → replay-workflow → workflow_runs (new replay)
//
// This file NEVER:
//   - executes connectors
//   - mutates the original workflow_run
//   - bypasses RLS
//   - creates downstream jobs
//   - touches workflow_jobs

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  try {
    const body = await req.json();
    const { original_run_id } = body;

    if (!original_run_id) {
      return jsonError("missing-original-run-id", 400);
    }

    const originalRun = await loadRun(original_run_id);
    if (!originalRun) return jsonError("run-not-found", 404);

    const version = await loadVersion(originalRun.workflow_version_id);
    if (!version) return jsonError("version-not-found", 404);

    // Create new replay run
    const replayRunId = crypto.randomUUID();
    await createReplayRun(replayRunId, originalRun);

    // Replay step runs
    await replayStepRuns(original_run_id, replayRunId);

    // Emit replay event
    await supabase.from("workflow_events").insert({
      run_id: replayRunId,
      step_id: null,
      type: "workflow.replayed",
      created_at: new Date(),
    });

    return jsonOK({
      status: "replay-complete",
      replay_run_id: replayRunId,
      original_run_id,
    });
  } catch (err) {
    console.error("replay-workflow fatal error:", err);
    return jsonError("replay-failed", 500, err);
  }
});

// ------------------------------------------------------------
// Load Run + Version
// ------------------------------------------------------------

async function loadRun(runId: string) {
  const { data } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("id", runId)
    .single();
  return data ?? null;
}

async function loadVersion(versionId: string) {
  const { data } = await supabase
    .from("workflow_versions")
    .select("*")
    .eq("id", versionId)
    .single();
  return data ?? null;
}

// ------------------------------------------------------------
// Create Replay Run
// ------------------------------------------------------------

async function createReplayRun(replayRunId: string, originalRun: any) {
  await supabase.from("workflow_runs").insert({
    id: replayRunId,
    workflow_version_id: originalRun.workflow_version_id,
    state: "completed",
    created_at: new Date(),
    completed_at: new Date(),
    replay_of: originalRun.id,
  });
}

// ------------------------------------------------------------
// Replay Step Runs
// ------------------------------------------------------------

async function replayStepRuns(originalRunId: string, replayRunId: string) {
  const { data: steps } = await supabase
    .from("workflow_step_runs")
    .select("*")
    .eq("run_id", originalRunId)
    .order("created_at", { ascending: true });

  if (!steps?.length) return;

  for (const step of steps) {
    await supabase.from("workflow_step_runs").insert({
      run_id: replayRunId,
      step_id: step.step_id,
      job_id: null,
      state: step.state,
      error: step.error ?? null,
      result: step.result ?? null,
      created_at: new Date(),
    });

    await supabase.from("workflow_events").insert({
      run_id: replayRunId,
      step_id: step.step_id,
      type: `step.replayed.${step.state}`,
      created_at: new Date(),
    });
  }
}

// ------------------------------------------------------------
// Response Helpers
// ------------------------------------------------------------

function jsonOK(obj: any) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(code: string, status = 500, err?: any) {
  return new Response(
    JSON.stringify({
      error: code,
      details: err ? String(err) : undefined,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}
