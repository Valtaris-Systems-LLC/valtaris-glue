// execute-workflow — now an ENQUEUE-only endpoint.
//
// Creates the workflow_run row, enqueues the root DAG nodes as
// workflow_jobs, then triggers the durable worker to start draining.
// No execution logic lives here anymore. All step execution happens in
// run-worker through typed connector adapters.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireTenantBinding } from "../_shared/auth.ts";
import { resolveExecutionSource } from "../_shared/runtime-versioning.ts";
import { buildRootWorkflowJobs, normalizeExecuteWorkflowRequest } from "./logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, key);

  try {
    const body = await req.json().catch(() => ({}));
    const binding = await requireTenantBinding(req, body?.tenant_id ?? null);
    if (!binding.ok) {
      return new Response(JSON.stringify({ error: binding.error }), {
        status: binding.status,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { dag_id, workflow_name, correlation_id, payload } = normalizeExecuteWorkflowRequest(
      body,
      () => crypto.randomUUID(),
    );
    const tenant_id = binding.ctx.tenantId;

    const resolved = await resolveExecutionSource(sb, {
      tenantId: tenant_id,
      dagId: dag_id,
      workflowName: workflow_name,
    });

    const { data: runRow, error: runErr } = await sb.from("workflow_runs").insert({
      workflow_name: resolved.workflowName,
      dag_id,
      tenant_id,
      user_id: binding.ctx.userId,
      state: "queued",
      status: "queued",
      correlation_id,
      workflow_version_id: resolved.workflowVersionId,
      payload,
      started_at: new Date().toISOString(),
    }).select().single();
    if (runErr) throw runErr;
    const run_id = runRow.id as string;

    await sb.from("workflow_events").insert({
      run_id,
      tenant_id,
      type: "run.enqueued",
      severity: "info",
      source: "execute-workflow",
      message: `Run enqueued: ${resolved.workflowName}`,
      data: {
        correlation_id,
        dag_id,
        actor_user_id: binding.ctx.userId,
        workflow_version_id: resolved.workflowVersionId,
        resolution_source: resolved.resolutionSource,
      },
    });

    // Enqueue root nodes (no dependencies)
    const rows = buildRootWorkflowJobs(
      resolved.graph,
      run_id,
      correlation_id,
      tenant_id,
      payload,
      resolved.workflowVersionId,
    );
    if (rows.length > 0) {
      const { error: jobsErr } = await sb.from("workflow_jobs").insert(rows);
      if (jobsErr) throw jobsErr;
    }

    await sb.from("workflow_runs").update({ state: "running", status: "running" }).eq("id", run_id);

    // Kick the worker (fire-and-forget). Multiple invocations are safe due to
    // FOR UPDATE SKIP LOCKED on claim_next_job.
    const workerUrl = `${url}/functions/v1/run-worker`;
    fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: "{}",
    }).catch((e) => console.error("[execute-workflow] worker kick failed", e));

    return new Response(JSON.stringify({ run_id, correlation_id, enqueued: rows.length }), {
      status: 202, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : (typeof e === "object" ? JSON.stringify(e) : String(e));
    console.error("[execute-workflow] error", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
