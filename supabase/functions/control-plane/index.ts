// Operational control plane — identity-bound.
// All actions require an authenticated caller; admin-only actions are gated
// by SQL functions that validate tenant_members.role = 'admin'.

import { requireTenantBinding, requireUser, serviceClient, logSecurity } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

function kickWorker() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  fetch(`${url}/functions/v1/run-worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: "{}",
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = await requireUser(req);
  if (!auth.ok) return j({ error: auth.error }, auth.status);
  const operator_uid = auth.ctx.userId;
  const sb = serviceClient();

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;
    if (!action) return j({ error: "action required" }, 400);

    switch (action) {
      case "drain_worker": {
        if (!body.worker_id) return j({ error: "worker_id required" }, 400);
        const { error } = await sb.rpc("drain_worker", {
          _worker_id: body.worker_id,
          _operator_uid: operator_uid,
        });
        if (error) return j({ error: error.message }, 403);
        return j({ ok: true });
      }
      case "pause_partition":
      case "resume_partition": {
        if (!body.partition_key) return j({ error: "partition_key required" }, 400);
        const { error } = await sb.rpc("pause_partition", {
          _partition_key: body.partition_key,
          _paused: action === "pause_partition",
          _operator_uid: operator_uid,
        });
        if (error) return j({ error: error.message }, 403);
        return j({ ok: true });
      }
      case "reconcile": {
        const { data } = await sb.rpc("reconcile_orphans", { _worker_stale_seconds: 180 });
        await logSecurity({
          actor_user_id: operator_uid,
          category: "operator.action",
          subject_type: "runtime",
          message: "reconcile_orphans invoked",
          details: { result: data?.[0] ?? null },
        });
        return j({ ok: true, result: data?.[0] ?? null });
      }
      case "archive_events": {
        const minutes = Number(body.older_than_minutes ?? 1440);
        const { data } = await sb.rpc("archive_old_events", { _older_than_minutes: minutes });
        return j({ ok: true, archived: data?.[0]?.archived ?? 0 });
      }
      case "aggregate": {
        await sb.rpc("aggregate_telemetry");
        return j({ ok: true });
      }
      case "health": {
        const tenant = await requireTenantBinding(req, body.tenant_id ?? null);
        if (!tenant.ok) return j({ error: tenant.error }, tenant.status);
        const { data } = await sb.rpc("runtime_health_report", {
          _tenant_id: tenant.ctx.tenantId,
          _include_worker_inventory: tenant.ctx.isAdmin,
        });
        return j({ ok: true, report: data });
      }
      case "throttle_connector": {
        const { connector, max_concurrency } = body;
        if (!connector || typeof max_concurrency !== "number") {
          return j({ error: "connector + max_concurrency required" }, 400);
        }
        // Admin-only — check via tenant_members.
        const { data: isAdmin } = await sb
          .from("tenant_members")
          .select("user_id")
          .eq("user_id", operator_uid)
          .eq("role", "admin")
          .maybeSingle();
        if (!isAdmin) {
          await logSecurity({
            actor_user_id: operator_uid,
            category: "authz.denied",
            severity: "warn",
            subject_type: "connector",
            subject_id: connector,
            message: "throttle_connector denied: admin required",
          });
          return j({ error: "admin role required" }, 403);
        }
        const key = `connector:${connector}`;
        await sb.from("queue_partitions").upsert(
          { partition_key: key, max_concurrency, description: `Connector throttle for ${connector}` },
          { onConflict: "partition_key" },
        );
        await sb.from("runtime_audit_log").insert({
          actor: operator_uid, action: "connector.throttle",
          subject_type: "connector", subject_id: connector, details: { max_concurrency },
        });
        await logSecurity({
          actor_user_id: operator_uid,
          category: "operator.action",
          subject_type: "connector",
          subject_id: connector,
          message: "connector throttled",
          details: { max_concurrency },
        });
        return j({ ok: true });
      }
      case "replay_dead_letter": {
        const { job_id } = body;
        if (!job_id) return j({ error: "job_id required" }, 400);
        const { data: job } = await sb.from("workflow_jobs").select("*").eq("id", job_id).single();
        if (!job) return j({ error: "job not found" }, 404);

        // Tenant authorization: caller must be operator on the job's tenant.
        const { data: allowed } = await sb.rpc("has_operator_role", {
          _uid: operator_uid, _tenant_id: job.tenant_id, _required: "operator",
        });
        if (!allowed) {
          await logSecurity({
            tenant_id: job.tenant_id,
            actor_user_id: operator_uid,
            category: "authz.denied",
            severity: "warn",
            subject_type: "job",
            subject_id: job_id,
            message: "replay_dead_letter denied",
          });
          return j({ error: "operator role required" }, 403);
        }

        await sb.from("workflow_jobs").update({
          state: "queued", retry_attempt: 0, error: null,
          backoff_until: null, scheduled_at: new Date().toISOString(),
          worker_id: null, started_at: null, completed_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", job_id);
        await sb.from("runtime_audit_log").insert({
          tenant_id: job.tenant_id, actor: operator_uid, action: "deadletter.replay",
          subject_type: "job", subject_id: job_id, details: { run_id: job.run_id },
        });
        await logSecurity({
          tenant_id: job.tenant_id,
          actor_user_id: operator_uid,
          category: "operator.action",
          subject_type: "job",
          subject_id: job_id,
          message: "dead-letter job re-queued",
        });
        kickWorker();
        return j({ ok: true });
      }
      case "pause_webhook":
      case "resume_webhook": {
        if (!body.endpoint_id) return j({ error: "endpoint_id required" }, 400);
        const { error } = await sb.rpc("pause_webhook", {
          _endpoint_id: body.endpoint_id, _paused: action === "pause_webhook",
          _operator_uid: operator_uid,
        });
        if (error) return j({ error: error.message }, 403);
        return j({ ok: true });
      }
      case "set_schedule_state": {
        if (!body.schedule_id || !body.state) return j({ error: "schedule_id + state required" }, 400);
        const { error } = await sb.rpc("set_schedule_state", {
          _schedule_id: body.schedule_id, _state: body.state, _operator_uid: operator_uid,
        });
        if (error) return j({ error: error.message }, 403);
        return j({ ok: true });
      }
      case "replay_webhook_delivery": {
        if (!body.delivery_id) return j({ error: "delivery_id required" }, 400);
        const { data: del } = await sb.from("webhook_deliveries").select("*").eq("id", body.delivery_id).maybeSingle();
        if (!del) return j({ error: "delivery not found" }, 404);
        const { data: allowed } = await sb.rpc("has_operator_role", {
          _uid: operator_uid, _tenant_id: del.tenant_id, _required: "operator",
        });
        if (!allowed) return j({ error: "operator role required" }, 403);
        const { data: ep } = await sb.from("webhook_endpoints").select("*").eq("id", del.endpoint_id).maybeSingle();
        if (!ep) return j({ error: "endpoint missing" }, 404);
        // Re-enqueue (mirrors webhook-ingress enqueue path).
        const { enqueueFromTrigger } = await import("../_shared/triggers.ts");
        const correlation_id = crypto.randomUUID();
        const result = await enqueueFromTrigger(sb, {
          tenant_id: del.tenant_id, dag_id: ep.dag_id,
          payload: { event: del.body, headers: del.headers, source: ep.source, endpoint_key: ep.endpoint_key, replayed_from: del.id },
          correlation_id,
          workflow_name: `webhook-replay:${ep.endpoint_key}`,
          trigger_kind: "webhook", source_label: `${ep.endpoint_key}:replay`,
        });
        if (!result.ok) return j({ error: result.error ?? "enqueue failed" }, 500);
        await sb.from("webhook_deliveries").insert({
          tenant_id: del.tenant_id, endpoint_id: del.endpoint_id, headers: del.headers,
          body: del.body, raw_body: del.raw_body, signature_valid: true,
          status: "enqueued", run_id: result.run_id, correlation_id,
        });
        await sb.from("runtime_audit_log").insert({
          tenant_id: del.tenant_id, actor: operator_uid, action: "webhook.replay",
          subject_type: "webhook_delivery", subject_id: body.delivery_id,
          details: { run_id: result.run_id },
        });
        return j({ ok: true, run_id: result.run_id });
      }

      default:
        return j({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return j({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
