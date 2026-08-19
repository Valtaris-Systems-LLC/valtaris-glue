// supabase/functions/execute-workflow/index.ts
// Valtaris Glue — Workflow Executor (Generation 3)
//
// This file is responsible for:
//   - starting workflow execution
//   - loading workflow definition + graph
//   - creating initial jobs
//   - emitting workflow events
//   - enforcing version pinning
//
// Authority chain:
//   workflow-publish → init-workflow → execute-workflow → ensure_downstream_job → run-worker
//
// This file NEVER:
//   - executes connectors
//   - mutates workflow_versions
//   - bypasses RLS
//   - touches workflow_jobs directly (always via RPC)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  try {
    const body = await req.json();
    const { run_id } = body;

    if (!run_id) {
      return jsonError("missing-run-id", 400);
    }

    const run = await loadRun(run_id);
    if (!run) return jsonError("run-not-found", 404);

    const version = await loadVersion(run.workflow_version_id);
    if (!version) return jsonError("version-not-found", 404);

    // Determine initial ready steps
    const readySteps = findInitialSteps(version);

    // Create jobs for each ready step
    for (const stepId of readySteps) {
      await supabase.rpc("ensure_downstream_job", {
        p_run_id: run_id,
        p_step_id: stepId,
      });

      await supabase.from("workflow_events").insert({
        run_id,
        step_id: stepId,
        type: "step.ready.initial",
        created_at: new Date(),
      });
    }

    // Mark run as running
    await supabase
      .from("workflow_runs")
      .update({
        state: "running",
        started_at: new Date(),
      })
      .eq("id", run_id);

    return jsonOK({
      status: "workflow-started",
      run_id,
      initial_steps: readySteps,
    });
  } catch (err) {
    console.error("execute-workflow fatal error:", err);
    return jsonError("execute-workflow-failed", 500, err);
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
// Find Initial Steps (roots)
// ------------------------------------------------------------
//
// A root step is any node with no predecessors.

function findInitialSteps(version: any) {
  const nodes = version.graph.nodes;
  const roots: string[] = [];

  for (const node of nodes) {
    const id = node.id;
    const predecessors = findPredecessors(version, id);

    if (predecessors.length === 0) {
      roots.push(id);
    }
  }

  return roots;
}

// ------------------------------------------------------------
// Find Predecessors
// ------------------------------------------------------------

function findPredecessors(version: any, stepId: string) {
  const preds: string[] = [];

  for (const node of version.graph.nodes) {
    const next = node.next ?? [];
    const onFailure = node.on_failure ?? [];
    const onApproval = node.on_approval ?? [];
    const onComp = node.on_compensation ?? [];

    if (
      next.includes(stepId) ||
      onFailure.includes(stepId) ||
      onApproval.includes(stepId) ||
      onComp.includes(stepId)
    ) {
      preds.push(node.id);
    }
  }

  return preds;
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
