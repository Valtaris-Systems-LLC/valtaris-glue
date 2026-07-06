// Health endpoint for long-lived worker processes.
// GET  -> liveness + recent worker stats
// POST -> graceful shutdown via worker_shutdown RPC
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { authorizeEndpointRequest } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const access = await authorizeEndpointRequest(req, "worker-health");
  if (!access.ok) {
    return new Response(JSON.stringify({ error: access.error }), {
      status: access.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (req.method === "POST") {
    const { worker_id } = await req.json().catch(() => ({}));
    if (!worker_id) {
      return new Response(JSON.stringify({ error: "worker_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const { data: released } = await sb.rpc("worker_shutdown", { _worker_id: worker_id });
    return new Response(JSON.stringify({ worker_id, released_jobs: released, ts: new Date().toISOString() }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: workers } = await sb.from("worker_registry")
    .select("worker_id,region,health_state,active_jobs,max_concurrency,last_heartbeat,total_processed,total_failed")
    .order("last_heartbeat", { ascending: false }).limit(50);
  const { data: health } = await sb.rpc("runtime_health_report");

  return new Response(JSON.stringify({ ok: true, workers, health, ts: new Date().toISOString() }), {
    status: 200, headers: { ...cors, "Content-Type": "application/json" },
  });
});
