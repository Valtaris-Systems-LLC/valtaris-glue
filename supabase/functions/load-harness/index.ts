// Synthetic workflow load generator. Spawns N runs against a target DAG and
// records the benchmark in load_benchmarks.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { authorizeEndpointRequest } from "../_shared/auth.ts";
import { enqueueFromTrigger } from "../_shared/triggers.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const access = await authorizeEndpointRequest(req, "load-harness");
  if (!access.ok) {
    return new Response(JSON.stringify({ error: access.error }), {
      status: access.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const {
    name = `load-${Date.now()}`,
    scenario = "synthetic_throughput",
    runs = 20,
    workflow_name = "demo.load",
    dag_id = "demo.live",
    tenant_id = null,
    concurrency = 5,
  } = body;

  const { data: bench } = await sb.from("load_benchmarks").insert({
    name, scenario, tenant_id,
    config: { runs, workflow_name, dag_id, concurrency },
    state: "running", total_runs: runs,
  }).select().single();

  const started = Date.now();
  let completed = 0, failed = 0;

  // Fire runs in batches sized by concurrency
  for (let i = 0; i < runs; i += concurrency) {
    const batch = Array.from({ length: Math.min(concurrency, runs - i) }, (_, k) =>
      enqueueFromTrigger(sb, {
        workflow_name, dag_id, tenant_id,
        trigger_kind: "manual", source_label: `load:${name}`,
        payload: { _load: { name, index: i + k } },
      }).then(() => completed++).catch(() => failed++)
    );
    await Promise.all(batch);
  }

  const duration = Date.now() - started;
  const throughput = duration > 0 ? (completed * 1000) / duration : 0;

  await sb.from("load_benchmarks").update({
    state: failed === runs ? "failed" : "completed",
    ended_at: new Date().toISOString(),
    duration_ms: duration,
    completed_runs: completed,
    failed_runs: failed,
    throughput_per_sec: Number(throughput.toFixed(3)),
    report: { fired: completed, errors: failed, duration_ms: duration },
  }).eq("id", bench!.id);

  // Kick worker to drain
  fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/run-worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    body: "{}",
  }).catch(() => {});

  return new Response(JSON.stringify({
    benchmark_id: bench!.id, fired: completed, failed, duration_ms: duration,
    throughput_per_sec: Number(throughput.toFixed(3)),
  }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
});
