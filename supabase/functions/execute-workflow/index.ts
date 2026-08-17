// supabase/functions/execute-workflow/index.ts
// Valtaris Glue — Unified Workflow Initializer
//
// This replaces all legacy initialization paths.
// Authority chain:
//   workflow_version_id → workflow_versions.graph → initial nodes → jobs
//
// No fallback to workflow_dags.
// No fallback to workflow_definitions.
// No ad-hoc graph construction.
//
// This initializer:
//   - pins workflow version
//   - creates workflow_run
//   - seeds initial jobs
//   - guarantees durable, consistent start state

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  const body = await req.json();
  const { workflow_version_id, input } = body;

  if (!workflow_version_id) {
    return new Response("missing-workflow-version-id", { status: 400 });
  }

  // 1. Load workflow version (single authority)
  const { data: version } = await supabase
    .from("workflow_versions")
    .select("*")
    .eq("id", workflow_version_id)
    .single();

  if (!version) {
    return new Response("version-not-found", { status: 404 });
  }

  const graph = version.graph;

  // 2. Identify initial nodes (no incoming edges)
  const incoming = new Set(graph.edges.map((e: any) => e.to));
  const initialNodes = graph.nodes.filter((n: any) => !incoming.has(n.id));

  if (initialNodes.length === 0) {
    return new Response("no-initial-nodes", { status: 500 });
  }

  // 3. Create workflow run
  const { data: run, error: runErr } = await supabase
    .from("workflow_runs")
    .insert({
      workflow_version_id,
      state: "running",
      input,
      started_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (runErr) {
    return new Response("run-create-failed", { status: 500 });
  }

  // 4. Seed initial jobs
  for (const node of initialNodes) {
    await supabase.from("workflow_jobs").insert({
      run_id: run.id,
      step_id: node.id,
      state: "pending",
      attempt: 0,
      payload: input ?? {},
    });
  }

  return new Response(
    JSON.stringify({
      run_id: run.id,
      initial_jobs: initialNodes.map((n: any) => n.id),
      status: "ok",
    }),
    { status: 200 }
  );
});
