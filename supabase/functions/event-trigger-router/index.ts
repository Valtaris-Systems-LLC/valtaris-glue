// Event trigger router — given a runtime event_type + payload, fire any
// matching runtime_triggers within their cooldown / depth budget.
// Called internally (run-worker, sla-sweeper, approval-decision) and externally
// for testing. Service-role only; rejects unauthenticated external calls.

import { svc, enqueueFromTrigger } from "../_shared/triggers.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function authorized(req: Request): boolean {
  const h = req.headers.get("authorization") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return h === `Bearer ${key}`;
}

/** Tiny condition evaluator: every key in cond must equal payload[key]. */
function matches(cond: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(cond ?? {})) {
    if (payload[k] !== v) return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!authorized(req)) return j({ error: "service role required" }, 401);

  const body = await req.json().catch(() => ({}));
  const { tenant_id, event_type, payload, depth } = body ?? {};
  if (!tenant_id || !event_type) return j({ error: "tenant_id + event_type required" }, 400);

  const sb = svc();
  const { data: triggers } = await sb.from("runtime_triggers")
    .select("*").eq("enabled", true).eq("tenant_id", tenant_id).eq("source_event_type", event_type);

  const fired: Array<{ trigger_id: string; ok: boolean; run_id?: string; reason?: string }> = [];

  for (const t of (triggers ?? [])) {
    // Cooldown
    if (t.last_fired_at) {
      const since = Date.now() - new Date(t.last_fired_at as string).getTime();
      if (since < (t.cooldown_seconds as number) * 1000) {
        fired.push({ trigger_id: t.id, ok: false, reason: "cooldown" });
        continue;
      }
    }
    // Depth
    if ((depth ?? 0) >= (t.max_depth as number)) {
      await sb.from("trigger_activations").insert({
        tenant_id, trigger_id: t.id, trigger_kind: "event", source_label: event_type,
        payload: payload ?? {}, depth: depth ?? 0, suppressed: true,
        suppressed_reason: `depth ${depth} >= max_depth ${t.max_depth}`,
      });
      fired.push({ trigger_id: t.id, ok: false, reason: "max_depth" });
      continue;
    }
    if (!matches((t.condition as Record<string, unknown> | null) ?? {}, (payload as Record<string, unknown> | null) ?? {})) {
      fired.push({ trigger_id: t.id, ok: false, reason: "condition_unmet" });
      continue;
    }

    const result = await enqueueFromTrigger(sb, {
      tenant_id,
      dag_id: t.dag_id as string,
      payload: { event_type, event: payload ?? {} },
      workflow_name: `event:${event_type}:${t.name}`,
      trigger_kind: "event",
      source_label: event_type,
      trigger_id: t.id as string,
      depth: (depth ?? 0) + 1,
    });
    await sb.from("runtime_triggers").update({ last_fired_at: new Date().toISOString() }).eq("id", t.id);
    fired.push({ trigger_id: t.id, ok: result.ok, run_id: result.run_id, reason: result.error });
  }

  return j({ ok: true, fired });
});
