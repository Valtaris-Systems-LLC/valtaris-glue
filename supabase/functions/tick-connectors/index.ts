// Connector state tick — simulates a control-plane health probe pass over
// every registered connector and writes the updated state row. Subscribers
// see the matrix update live via realtime.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { authorizeEndpointRequest } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function nextStatus(prev: string, failureRate: number): { status: string; backoffMs: number; err: string | null } {
  // Mostly stable; occasionally degrade or recover
  const roll = Math.random();
  if (failureRate > 0.15 || roll < 0.05) return { status: "degraded", backoffMs: 0, err: "elevated p95 latency" };
  if (roll < 0.02) return { status: "retrying", backoffMs: 2000, err: "transient 5xx" };
  if (roll < 0.01) return { status: "down", backoffMs: 8000, err: "upstream unavailable" };
  return { status: "healthy", backoffMs: 0, err: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const access = await authorizeEndpointRequest(req, "tick-connectors");
  if (!access.ok) {
    return new Response(JSON.stringify({ error: access.error }), {
      status: access.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, key);

  try {
    const { data: rows } = await sb.from("connector_state").select("*");
    const updates: Array<Record<string, unknown>> = [];

    for (const r of rows ?? []) {
      const latency = Math.max(40, Math.round((r.latency_ms ?? 200) * (0.7 + Math.random() * 0.7)));
      const failureDrift = Math.max(0, Math.min(0.25, (r.failure_rate ?? 0) + (Math.random() - 0.55) * 0.04));
      const { status, backoffMs, err } = nextStatus(r.status, failureDrift);
      const quotaInc = Math.round(5 + Math.random() * 30);

      updates.push({
        id: r.id,
        status,
        latency_ms: latency,
        failure_rate: Number(failureDrift.toFixed(3)),
        quota_used: Math.min((r.quota_limit ?? 1000), (r.quota_used ?? 0) + quotaInc),
        backoff_until: backoffMs > 0 ? new Date(Date.now() + backoffMs).toISOString() : null,
        last_success_at: status === "healthy" ? new Date().toISOString() : r.last_success_at,
        last_error: err ?? null,
        updated_at: new Date().toISOString(),
      });
    }

    for (const u of updates) {
      const id = u.id;
      delete u.id;
      await sb.from("connector_state").update(u).eq("id", id as string);
    }

    return new Response(JSON.stringify({ ticked: updates.length }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
