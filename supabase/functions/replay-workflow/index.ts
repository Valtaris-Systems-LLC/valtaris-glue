// supabase/functions/replay-workflow/index.ts
// Valtaris Glue — Unified Replay Engine
//
// Replay allows Glue to reconstruct workflow execution deterministically.
// It enforces:
//   - idempotency
//   - version authority
//   - graph authority
//   - step lifecycle correctness
//   - job lifecycle correctness
//   - run lifecycle correctness
//
// Replay NEVER re-executes connectors.
// Replay ONLY replays stored idempotent results.
//
// Authority chain:
//   replay-workflow → run-lifecycle → step-lifecycle → job-lifecycle → idempotency

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  const body = await req.json();
  const { run_id } = body;

  if (!run_id) {
    return new Response("missing-run-id", { status: 400 });
  }

  // 1. Load run
  const { data: run } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("id", run_id)
    .single();

  if (!run) {
    return new Response("run-not-found", { status: 404 });
  }

  // 2. Mark run as replaying
  await supabase.functions.invoke("run-lifecycle", {
    body: { run_id, action: "replay" },
  });

  // 3. Load workflow version
  const { data: version } = await supabase
    .from("workflow_versions")
    .select("*")
    .eq("id", run.workflow_version_id)
    .single();

  if (!version) {
    return new Response("version-not-found", { status: 404 });
  }

  const graph = version.graph;

  // 4. Load step runs
  const { data: stepRuns } = await supabase
    .from("workflow_step_runs")
    .select("*")
    .eq("run_id", run_id);

  // 5. Replay each step deterministically
  for (const stepRun of stepRuns) {
    const step = graph.nodes.find((n: any) => n.id === stepRun.step_id);
    if (!step) continue;

    // Replay only completed steps
    if (stepRun.state === "completed") {
      await supabase.functions.invoke("step-lifecycle", {
        body: {
          run_id,
          step_id: stepRun.step_id,
          action: "complete",
        },
      });
      continue;
    }

    // Replay failed steps
    if (stepRun.state === "failed") {
      await supabase.functions.invoke("step-lifecycle", {
        body: {
          run_id,
          step_id: stepRun.step_id,
          action: "fail",
          error: stepRun.error,
        },
      });
      continue;
    }

    // Replay dead-letter steps
    if (stepRun.state === "dead_letter") {
      await supabase.functions.invoke("step-lifecycle", {
        body: {
          run_id,
          step_id: stepRun.step_id,
          action: "dead_letter",
          error: stepRun.error,
        },
      });
      continue;
    }

    // Replay compensation steps
    if (stepRun.state === "compensating" || stepRun.state === "compensated") {
      await supabase.functions.invoke("step-lifecycle", {
        body: {
          run_id,
          step_id: stepRun.step_id,
          action: "compensate",
        },
      });
      continue;
    }
  }

  // 6. Replay jobs using idempotency registry
  const { data: jobs } = await supabase
    .from("workflow_jobs")
    .select("*")
    .eq("run_id", run_id);

  for (const job of jobs) {
    const key = `${job.id}-${job.step_id}`;

    // Load idempotent result
    const { data: idem } = await supabase
      .from("workflow_idempotency")
      .select("*")
      .eq("key", key)
      .single();

    // Replay job lifecycle
    if (job.state === "completed") {
      await supabase.functions.invoke("job-lifecycle", {
        body: { job_id: job.id, action: "complete" },
      });
    }

    if (job.state === "failed") {
      await supabase.functions.invoke("job-lifecycle", {
        body: { job_id: job.id, action: "fail", error: job.error },
      });
    }

    if (job.state === "dead_letter") {
      await supabase.functions.invoke("job-lifecycle", {
        body: { job_id: job.id, action: "dead_letter", error: job.error },
      });
    }

    if (job.state === "compensating") {
      await supabase.functions.invoke("job-lifecycle", {
        body: { job_id: job.id, action: "compensate" },
      });
    }
  }

  // 7. Mark run as replay completed
  await supabase.functions.invoke("run-lifecycle", {
    body: { run_id, action: "replay_completed" },
  });

  return new Response(
    JSON.stringify({
      run_id,
      status: "replay-completed",
    }),
    { status: 200 }
  );
});
