// Captures queue pressure, worker capacity, evaluates circuit breakers.
// Designed to be invoked on a schedule (pg_cron or external scheduler).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { authorizeEndpointRequest } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const access = await authorizeEndpointRequest(req, "scale-monitor");
  if (!access.ok) {
    return new Response(JSON.stringify({ error: access.error }), {
      status: access.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const [pressure, capacity, breakers] = await Promise.all([
    sb.rpc("capture_queue_pressure"),
    sb.rpc("capture_worker_capacity"),
    sb.rpc("evaluate_circuit_breakers"),
  ]);

  return new Response(JSON.stringify({
    pressure: pressure.data,
    worker_snapshots: capacity.data,
    breakers_transitioned: breakers.data,
    ts: new Date().toISOString(),
  }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
});
