// supabase/functions/worker-finalize/index.ts
// Valtaris Glue — Worker Finalization Engine (Generation 3)
//
// This file is responsible for:
//   - finalizing job execution inside the worker
//   - reporting job completion or failure
//   - releasing job leases
//   - emitting worker.finalized events
//   - handing control back to job-lifecycle + step-lifecycle
//
// Authority chain:
//   run-worker → worker-finalize → job-lifecycle → step-lifecycle → schedule-next-job
//
// This file NEVER:
//   - executes connectors
//   - mutates workflow_versions
//   - bypasses RLS
//   - schedules jobs directly

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const NOW = () => new Date();

serve(async (req) => {
  try {
    const body = await req.json();
    const { job_id, worker_id, status, result, error } = body;

    if (!job_id || !worker_id || !status) {
      return jsonError("missing-fields", 400);
    }

    const job = await loadJob(job_id);
    if (!job) return jsonError("job-not-found", 404);

    // Emit worker.finalized event
    await emitEvent(job.run_id, job.step_id, "worker.finalized", {
      worker_id,
      job_id,
      status,
      result,
      error,
    });

    // Release lease
    await releaseLease(job_id, worker_id);

    // Forward to job-lifecycle
    if (status === "completed") {
      await supabase.functions.invoke("job-lifecycle", {
        body: {
          job_id,
          action: "complete",
          result,
        },
      });
    } else if (status === "failed") {
      await supabase.functions.invoke("job-lifecycle", {
        body: {
          job_id,
          action: "fail",
          error,
        },
      });
    } else {
      return jsonError("invalid-status", 400);
    }

    return jsonOK({
      status: "worker-finalized",
      job_id,
      worker_id,
      lifecycle_action: status,
    });
  } catch (err) {
    console.error("worker-finalize fatal error:", err);
    return jsonError("worker-finalize-failed", 500, err);
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
// Release Lease
// ------------------------------------------------------------

async function releaseLease(job_id: string, worker_id: string) {
  await supabase
    .from("workflow_jobs")
    .update({
      claimed_by: null,
      lease_expires_at: null,
    })
    .eq("id", job_id)
    .eq("claimed_by", worker_id);
}

// ------------------------------------------------------------
// Event Helper
// ------------------------------------------------------------

async function emitEvent(run_id: string, step_id: string, type: string, details: any) {
  await supabase.from("workflow_events").insert({
    run_id,
    step_id,
    type,
    details,
    created_at: NOW(),
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

function jsonError(code: string, status = 500, details?: any) {
  return new Response(
    JSON.stringify({
      error: code,
      details,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}
