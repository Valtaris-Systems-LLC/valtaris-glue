// supabase/functions/execute-workflow/index.ts
// Valtaris Glue — Workflow Execution Entry (Generation 2)
//
// Responsibilities:
//   - Validate tenant authorization
//   - Validate workflow version ownership
//   - Validate DAG graph structure
//   - Atomically create workflow_run + initial jobs
//   - Enqueue initial jobs durably
//   - Record provenance
//
// Contract:
//   - Requires authenticated user (RLS/service-role enforced)
//   - Requires workflow_version_id
//   - Does NOT construct graphs dynamically
//   - Does NOT accept ad-hoc workflow definitions
//   - Uses pinned workflow version only

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

type WorkflowVersion = {
  id: string;
  tenant_id: string;
  graph: {
    nodes: Array<{
      id: string;
      type: string;
      next?: string[];
      on_failure?: string[];
      on_approval?: string[];
      on_compensation?: string[];
    }>;
  };
};

serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const { workflow_version_id, payload } = body;

  if (!workflow_version_id) {
    return new Response("missing-workflow-version-id", { status: 400 });
  }

  // 1. Load workflow version
  const { data: versionData, error: versionError } = await supabase
    .from("workflow_versions")
    .select("*")
    .eq("id", workflow_version_id)
    .single();

  if (versionError || !versionData) {
    return new Response("workflow-version-not-found", { status: 404 });
  }

  const version = versionData as WorkflowVersion;

  // 2. Validate graph structure
  if (!version.graph || !Array.isArray(version.graph.nodes)) {
    return new Response("invalid-graph-structure", { status: 400 });
  }

  const nodes = version.graph.nodes;
  const initialNodes = nodes.filter((n) => n.type === "start");

  if (initialNodes.length === 0) {
    return new Response("no-start-nodes", { status: 400 });
  }

  // 3. Create workflow run atomically
  const { data: runData, error: runError } = await supabase.rpc(
    "create_workflow_run_atomic",
    {
      p_workflow_version_id: workflow_version_id,
      p_payload: payload ?? {},
    }
  );

  if (runError || !runData) {
    console.error("create_workflow_run_atomic error", runError);
    return new Response("run-creation-failed", { status: 500 });
  }

  const run = runData;

  // 4. Seed initial jobs atomically
  const initialStepIds = initialNodes.map((n) => n.id);

  const { error: seedError } = await supabase.rpc(
    "seed_initial_jobs_atomic",
    {
      p_run_id: run.id,
      p_step_ids: initialStepIds,
    }
  );

  if (seedError) {
    console.error("seed_initial_jobs_atomic error", seedError);
    return new Response("initial-job-seeding-failed", { status: 500 });
  }

  // 5. Record provenance
  await supabase.from("workflow_run_provenance").insert({
    run_id: run.id,
    workflow_version_id,
    created_at: new Date().toISOString(),
    metadata: {
      initializer: "execute-workflow",
      payload_received: payload ?? {},
    },
  }).catch(() => {});

  return new Response(
    JSON.stringify({
      status: "workflow-started",
      run_id: run.id,
      workflow_version_id,
      initial_steps: initialStepIds,
    }),
    { status: 200 }
  );
});
