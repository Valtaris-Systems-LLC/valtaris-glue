// Compensation / rollback executor.
//
// POST { run_id, reason?, triggered_by? } → walks completed step checkpoints
// in reverse order and executes the configured compensation per DAG node
// (e.g. stripe refund, slack delete-message). Each step emits telemetry and
// is recorded in workflow_rollbacks.compensations for audit + replay.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getConnector } from "../_shared/connectors.ts";
import { resolveExecutionSource } from "../_shared/runtime-versioning.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DagNode { id: string; name: string; connector: string; compensation?: { action: string; input?: Record<string, unknown> }; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json();
    const { run_id, reason, triggered_by = "operator" } = body;
    if (!run_id) {
      return new Response(JSON.stringify({ error: "run_id required" }), { status: 400, headers: cors });
    }

    const { data: run } = await sb.from("workflow_runs").select("*").eq("id", run_id).single();
    if (!run) {
      return new Response(JSON.stringify({ error: "run not found" }), { status: 404, headers: cors });
    }
    const resolved = await resolveExecutionSource(sb, {
      tenantId: run.tenant_id ?? null,
      dagId: run.dag_id ?? "demo.live",
      workflowVersionId: run.workflow_version_id ?? null,
      workflowName: run.workflow_name ?? null,
    });
    const graph = resolved.graph as { nodes: DagNode[] };

    const { data: rollback } = await sb.from("workflow_rollbacks").insert({
      run_id, triggered_by, reason, state: "running",
    }).select().single();

    const { data: steps } = await sb
      .from("workflow_step_runs")
      .select("*")
      .eq("run_id", run_id)
      .eq("state", "completed")
      .order("step_index", { ascending: false });

    const compensations: Array<Record<string, unknown>> = [];

    for (const s of steps ?? []) {
      const node = graph.nodes.find((n) => n.id === s.dag_node_id);
      if (!node?.compensation) continue;
      const adapter = getConnector(node.connector);
      const t0 = Date.now();
      const res = await adapter.execute(node.compensation.action, {
        ...(node.compensation.input ?? {}),
        original_outputs: s.outputs,
        rollback: true,
      }, { idempotencyKey: `rb:${rollback.id}:${node.id}` });

      compensations.push({
        node_id: node.id, name: node.name, connector: node.connector,
        action: node.compensation.action, ok: res.ok,
        latency_ms: Date.now() - t0, error: res.error?.message ?? null,
      });

      await sb.from("workflow_events").insert({
        run_id, step_id: s.id,
        type: res.ok ? "rollback.step.completed" : "rollback.step.failed",
        severity: res.ok ? "info" : "error",
        source: "rollback-executor",
        message: `${res.ok ? "↶" : "✗"} compensate ${node.name} via ${node.compensation.action}`,
        data: { ok: res.ok, mock: res.mock, error: res.error?.message },
      });

      await sb.from("runtime_audit_log").insert({
        actor: triggered_by, action: "rollback.step",
        subject_type: "step", subject_id: s.id,
        details: { node_id: node.id, ok: res.ok, error: res.error?.message ?? null },
      });
    }

    const ok = compensations.every((c) => c.ok);
    await sb.from("workflow_rollbacks").update({
      state: ok ? "completed" : "failed",
      compensations,
      ended_at: new Date().toISOString(),
    }).eq("id", rollback.id);

    await sb.from("workflow_events").insert({
      run_id,
      type: ok ? "rollback.completed" : "rollback.failed",
      severity: ok ? "info" : "error",
      source: "rollback-executor",
      message: `Rollback ${ok ? "completed" : "failed"} (${compensations.length} steps)`,
      data: { count: compensations.length, reason },
    });

    if (!ok) {
      await sb.from("workflow_incidents").insert({
        run_id, severity: "error", category: "rollback_failed",
        summary: `Rollback failed for run ${run_id}`,
      });
    }

    return new Response(JSON.stringify({ rollback_id: rollback.id, ok, steps: compensations.length }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: cors });
  }
});
