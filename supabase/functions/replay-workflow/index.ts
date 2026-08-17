// supabase/functions/replay-workflow/index.ts
// Valtaris Glue — Observational Replay Engine
//
// Safe replay model:
//   original workflow_run
//       → workflow_version (immutable)
//       → workflow_step_runs (evidence)
//       → checkpoints/snapshots
//       → NEW replay workflow_run
//       → reconstructed timeline/state
//
// Replay NEVER:
//   - re-executes connectors
//   - mutates the original run
//   - deletes jobs
//   - requeues steps
//
// Replay ALWAYS:
//   - creates a new run
//   - uses observational evidence
//   - reconstructs state deterministically

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  const { run_id } = await req.json();

  if (!run_id) {
    return new Response("missing-run-id", { status: 400 });
  }

  // 1. Load original run
  const { data: original } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("id", run_id)
    .single();

  if (!original) {
    return new Response("run-not-found", { status: 404 });
  }

  // 2. Load workflow version (immutable authority)
  const { data: version } = await supabase
    .from("workflow_versions")
    .select("*")
    .eq("id", original.workflow_version_id)
    .single();

  if (!version) {
    return new Response("version-not-found", { status: 404 });
  }

  // 3. Load step runs (observational evidence)
  const { data: steps } = await supabase
    .from("workflow_step_runs")
    .select("*")
    .eq("run_id", run_id)
    .order("created_at", { ascending: true });

  // 4. Load checkpoints/snapshots
  const { data: snapshots } = await supabase
    .from("workflow_snapshots")
    .select("*")
    .eq("run_id", run_id)
    .order("timestamp", { ascending: true });

  // 5. Create NEW replay run
  const { data: replayRun, error: replayErr } = await supabase
    .from("workflow_runs")
    .insert({
      workflow_version_id: original.workflow_version_id,
      state: "replay",
      original_run_id: original.id,
      started_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (replayErr) {
    return new Response("replay-run-create-failed", { status: 500 });
  }

  // 6. Reconstruct timeline
  const timeline = [];

  for (const step of steps) {
    timeline.push({
      type: "step",
      step_id: step.step_id,
      state: step.state,
      started_at: step.started_at,
      completed_at: step.completed_at,
      result: step.result,
    });
  }

  for (const snap of snapshots) {
    timeline.push({
      type: "snapshot",
      snapshot_id: snap.id,
      timestamp: snap.timestamp,
      state: snap.state,
    });
  }

  // 7. Store replay timeline
  await supabase.from("workflow_replays").insert({
    replay_run_id: replayRun.id,
    original_run_id: original.id,
    timeline,
    created_at: new Date().toISOString(),
  });

  // 8. Mark replay complete
  await supabase
    .from("workflow_runs")
    .update({
      state: "replay_completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", replayRun.id);

  return new Response(
    JSON.stringify({
      replay_run_id: replayRun.id,
      timeline_count: timeline.length,
      status: "ok",
    }),
    { status: 200 }
  );
});
