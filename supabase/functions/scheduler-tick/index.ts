// Scheduler tick — fires every due workflow_schedules row.
// Designed to be invoked by cron (pg_cron net.http_post) or operator.
// claim_due_schedules() advances next_run_at atomically so concurrent ticks
// don't double-fire.

import { authorizeEndpointRequest } from "../_shared/auth.ts";
import { svc, enqueueFromTrigger } from "../_shared/triggers.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const access = await authorizeEndpointRequest(req, "scheduler-tick");
  if (!access.ok) return j({ error: access.error }, access.status);
  const sb = svc();

  const { data: due, error } = await sb.rpc("claim_due_schedules", { _limit: 50 });
  if (error) return j({ error: error.message }, 500);

  const fired: Array<{ schedule_id: string; run_id?: string; ok: boolean; error?: string }> = [];
  for (const s of (due ?? []) as Array<Record<string, unknown>>) {
    const result = await enqueueFromTrigger(sb, {
      tenant_id: s.tenant_id,
      dag_id: s.dag_id,
      payload: s.payload ?? {},
      workflow_name: `schedule:${s.name}`,
      trigger_kind: "schedule",
      source_label: s.name,
    });
    await sb.rpc("record_schedule_run", {
      _schedule_id: s.id, _run_id: result.run_id ?? null, _success: result.ok,
    });
    if (!result.ok) {
      await sb.from("workflow_incidents").insert({
        tenant_id: s.tenant_id,
        severity: "warn",
        category: "schedule_failure",
        summary: `Scheduled run failed to enqueue: ${s.name} — ${result.error ?? "unknown"}`,
      });
    }
    fired.push({ schedule_id: s.id, run_id: result.run_id, ok: result.ok, error: result.error });
  }

  return j({ ok: true, fired_count: fired.length, fired });
});
