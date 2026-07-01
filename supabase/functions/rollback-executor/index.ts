// Compensation / rollback executor.
//
// POST { run_id, reason? } → walks completed step checkpoints in reverse order
// and executes the configured compensation per DAG node (e.g. stripe refund,
// slack delete-message). Each step emits telemetry and is recorded in
// workflow_rollbacks.compensations for audit + replay.
//
// Auth: caller must present a valid bearer token. triggered_by is always set
// to the authenticated user id (body.triggered_by is ignored). The caller must
// have operator or admin membership in the run's tenant. If the run has no
// tenant_id the request is rejected unless the caller used the service-role key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getConnector } from "../_shared/connectors.ts";
import { requireUser, logSecurity } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DagNode { id: string; name: string; connector: string; compensation?: { action: string; input?: Record<string, unknown> }; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Detect service-role callers (opaque API key, not a user JWT).
  const rawToken = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const isServiceRole = rawToken === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  let actorId: string;

  if (isServiceRole) {
    actorId = "service_role";
  } else {
    const auth = await requireUser(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.error }), { status: auth.status, headers: cors });
    }
    actorId = auth.ctx.userId;
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json();
    // triggered_by is always the authenticated caller — body field is intentionally ignored.
    const { run_id, reason } = body;
    const triggered_by = actorId;
    if (!run_id) {
      return new Response(JSON.stringify({ error: "run_id required" }), { status: 400, headers: cors });
    }

    const { data: run } = await sb.from("workflow_runs").select("*").eq("id", run_id).single();
    if (!run) {
      return new Response(JSON.stringify({ error: "run not found" }), { status: 404, headers: cors });
    }

    // Tenant authorization: reject NULL tenant_id unless service-role, and
    // verify the caller has at least operator access to the run's tenant.
    if (!run.tenant_id) {
      if (!isServiceRole) {
        await logSecurity({
          actor_user_id: actorId,
          category: "authz.denied",
          severity: "warn",
          subject_type: "workflow_run",
          subject_id: run_id,
          message: "rollback rejected: run has no tenant_id",
        });
        return new Response(JSON.stringify({ error: "forbidden: run has no tenant context" }), { status: 403, headers: cors });
      }
    } else if (!isServiceRole) {
      const { data: membership } = await sb
        .from("tenant_members")
        .select("role")
        .eq("tenant_id", run.tenant_id)
        .eq("user_id", actorId)
        .in("role", ["operator", "admin"])
        .maybeSingle();

      if (!membership) {
        await logSecurity({
          tenant_id: run.tenant_id,
          actor_user_id: actorId,
          category: "authz.denied",
          severity: "warn",
          subject_type: "workflow_run",
          subject_id: run_id,
          message: "rollback rejected: caller lacks operator/admin role in tenant",
        });
        return new Response(JSON.stringify({ error: "forbidden: operator or admin role required" }), { status: 403, headers: cors });
      }
    }
    const { data: dagRow } = await sb.from("workflow_dags").select("graph").eq("id", run.dag_id ?? "demo.live").single();
    const graph = (dagRow?.graph ?? { nodes: [] }) as { nodes: DagNode[] };

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
        tenant_id: run.tenant_id ?? null,
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
      tenant_id: run.tenant_id ?? null,
      type: ok ? "rollback.completed" : "rollback.failed",
      severity: ok ? "info" : "error",
      source: "rollback-executor",
      message: `Rollback ${ok ? "completed" : "failed"} (${compensations.length} steps)`,
      data: { count: compensations.length, reason },
    });

    if (!ok) {
      await sb.from("workflow_incidents").insert({
        run_id, tenant_id: run.tenant_id ?? null, severity: "error", category: "rollback_failed",
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
