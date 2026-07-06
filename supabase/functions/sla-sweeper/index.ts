// Periodically called sweeper for SLA + stale jobs + expired approvals.
// Idempotent and safe to invoke concurrently.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { authorizeEndpointRequest } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const access = await authorizeEndpointRequest(req, "sla-sweeper");
  if (!access.ok) {
    return new Response(JSON.stringify({ error: access.error }), {
      status: access.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const [stale, breaches, expired] = await Promise.all([
    sb.rpc("sweep_stale_jobs", { _lease_seconds: 120 }),
    sb.rpc("detect_sla_breaches"),
    sb.rpc("expire_pending_approvals"),
  ]);

  const recovered = stale.data?.[0]?.recovered ?? 0;
  const breachedCount = breaches.data?.[0]?.breached ?? 0;
  const expiredCount = expired.data?.[0]?.expired ?? 0;

  // If we recovered any stale jobs, kick the worker
  if (recovered > 0 || expiredCount > 0) {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    fetch(`${url}/functions/v1/run-worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: "{}",
    }).catch(() => {});
  }

  await sb.from("runtime_audit_log").insert({
    actor: "sla-sweeper",
    action: "sweep.tick",
    details: { recovered, breaches: breachedCount, expired: expiredCount },
  });

  return new Response(JSON.stringify({ recovered, breaches: breachedCount, expired: expiredCount }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
