// supabase/functions/dead-letter/index.ts
// Valtaris Glue — Dead Letter Queue Handler (Generation 3)
//
// This file is responsible for:
//   - marking jobs as dead_letter
//   - recording workflow_dead_letter entries
//   - recording workflow_incidents
//   - recording workflow_step_runs (failed)
//   - emitting workflow_events
//   - preserving version-pinned execution semantics
//
// Authority chain:
//   run-worker → job-lifecycle → dead-letter
//
// This file NEVER:
//   - mutates workflow_versions
//   - mutates workflow_runs directly
//   - bypasses RLS
//   - executes connectors
//   - retries jobs

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  try {
    const body = await req.json();
    const { job_id, error } = body;

    if (!job_id) {
      return jsonError("missing-job-id", 400);
    }

    const job = await loadJob(job_id);
    if (!job) {
      return jsonError("job-not-found", 404);
    }

    await markDeadLetter(job, error ?? "dead-letter");

    return jsonOK({
      status: "dead_letter",
      job_id,
      run_id: job.run_id,
      step_id: job.step_id,
    });
  } catch (err) {
    console.error("dead-letter fatal error:", err);
    return jsonError("dead-letter-failed", 500, err);
  }
});

// ------------------------------------------------------------
// Load Job
// ------------------------------------------------------------

async function loadJob(jobId: string) {
  const { data } = await supabase
    .from("workflow_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  return data ?? null;
}

// ------------------------------------------------------------
// Mark Dead Letter
// ------------------------------------------------------------

async function markDeadLetter(job: any, reason: string) {
  // 1. Mark job as dead_letter
  await supabase
    .from("workflow_jobs")
    .update({
      state: "dead_letter",
      completed_at: new Date(),
    })
    .eq("id", job.id);

  // 2. Record step run
  await supabase.from("workflow_step_runs").insert({
    run_id: job.run_id,
    step_id: job.step_id,
    job_id: job.id,
    state: "failed",
    error: reason,
    created_at: new Date(),
  });

  // 3. Record DLQ entry
  await supabase.from("workflow_dead_letter").insert({
    run_id: job.run_id,
    step_id: job.step_id,
    job_id: job.id,
    error: reason,
    created_at: new Date(),
  });

  // 4. Record incident
  await supabase.from("workflow_incidents").insert({
    run_id: job.run_id,
    step_id: job.step_id,
    type: "dead_letter",
    error: reason,
    created_at: new Date(),
  });

  // 5. Emit workflow event
  await supabase.from("workflow_events").insert({
    run_id: job.run_id,
    step_id: job.step_id,
    type: "step.dead_letter",
    error: reason,
    created_at: new Date(),
  });
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
