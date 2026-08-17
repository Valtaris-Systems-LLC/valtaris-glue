// supabase/functions/run-worker/index.ts
// Valtaris Glue — Unified Durable Worker Runtime
//
// This replaces all legacy execution paths.
// Authority chain:
//   workflow_runs.workflow_version_id
//       → workflow_versions.graph
//       → step
//       → job
//       → worker
//
// No fallback to workflow_dags.
// No fallback to workflow_definitions.
// No re-deriving graphs from ad-hoc sources.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Lease duration for jobs
const LEASE_MS = 1000 * 30; // 30 seconds

serve(async () => {
  // 1. Claim a job
  const { data: job, error: claimError } = await supabase
    .from("workflow_jobs")
    .update({
      claimed_at: new Date().toISOString(),
      claimed_by: "worker",
      lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
    })
    .eq("state", "pending")
    .is("claimed_at", null)
    .select("*")
    .limit(1)
    .single();

  if (claimError || !job) {
    return new Response("no-job");
  }

  const jobId = job.id;

  // 2. Load workflow run
  const { data: run } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("id", job.run_id)
    .single();

  if (!run) {
    await failJob(jobId, "run-not-found");
    return new Response("run-not-found");
  }

  // 3. Load workflow version (single authority)
  const { data: version } = await supabase
    .from("workflow_versions")
    .select("*")
    .eq("id", run.workflow_version_id)
    .single();

  if (!version) {
    await failJob(jobId, "version-not-found");
    return new Response("version-not-found");
  }

  const graph = version.graph;
  const step = graph.nodes.find((n: any) => n.id === job.step_id);

  if (!step) {
    await failJob(jobId, "step-not-found");
    return new Response("step-not-found");
  }

  // 4. Idempotency key
  const idempotencyKey = `${run.id}:${step.id}:${job.attempt}`;

  // 5. Execute step
  try {
    const result = await executeStep(step, job.payload, idempotencyKey);

    // 6. Mark job completed
    await supabase
      .from("workflow_jobs")
      .update({
        state: "completed",
        completed_at: new Date().toISOString(),
        result,
      })
      .eq("id", jobId);

    // 7. Queue downstream jobs
    const downstream = graph.edges
      .filter((e: any) => e.from === step.id)
      .map((e: any) => e.to);

    for (const nextStepId of downstream) {
      await supabase.from("workflow_jobs").insert({
        run_id: run.id,
        step_id: nextStepId,
        state: "pending",
        attempt: 0,
        payload: {},
      });
    }

    // 8. Terminal run handling
    await finalizeRunIfTerminal(run.id);

    return new Response("ok");
  } catch (err) {
    // 9. Retry logic
    const nextAttempt = job.attempt + 1;

    if (nextAttempt > (step.max_retries ?? 3)) {
      await failJob(jobId, err.message);
      await markRunFailed(run.id);
      return new Response("failed");
    }

    // exponential backoff
    const backoffMs = Math.pow(2, nextAttempt) * 1000;

    await supabase
      .from("workflow_jobs")
      .update({
        state: "pending",
        attempt: nextAttempt,
        claimed_at: null,
        lease_expires_at: null,
        available_at: new Date(Date.now() + backoffMs).toISOString(),
      })
      .eq("id", jobId);

    return new Response("retry");
  }
});

// ----------------------------
// Helpers
// ----------------------------

async function executeStep(step: any, payload: any, idempotencyKey: string) {
  // All connector calls must be idempotent or guarded.
  switch (step.type) {
    case "task":
      return await runTask(step.run, payload, idempotencyKey);

    case "noop":
      return { ok: true };

    default:
      throw new Error(`unknown-step-type: ${step.type}`);
  }
}

async function runTask(name: string, payload: any, idempotencyKey: string) {
  // This is where connector bindings plug in.
  // For now, we assume tasks are registered in the runtime.
  const url = Deno.env.get("TASK_RUNTIME_URL")!;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, payload, idempotencyKey }),
  });

  if (!res.ok) {
    throw new Error(`task-failed: ${name}`);
  }

  return await res.json();
}

async function failJob(jobId: string, reason: string) {
  await supabase
    .from("workflow_jobs")
    .update({
      state: "failed",
      error: reason,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

async function markRunFailed(runId: string) {
  await supabase
    .from("workflow_runs")
    .update({
      state: "failed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

async function finalizeRunIfTerminal(runId: string) {
  const { data: jobs } = await supabase
    .from("workflow_jobs")
    .select("state")
    .eq("run_id", runId);

  const allDone = jobs.every((j: any) => j.state === "completed");
  if (allDone) {
    await supabase
      .from("workflow_runs")
      .update({
        state: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
  }
}
