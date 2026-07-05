// runtime-validate
// ---------------------------------------------------------------------------
// Read-only runtime consistency / integrity checker. Surfaces operational
// anomalies that the dashboards should never silently hide.
//
// Returns a structured report:
//   {
//     checks: [{ id, severity, ok, count, sample, message }],
//     summary: { ok, warn, error }
//   }
//
// Used by the operator console "Runtime Health" panel and by ops scripts.
// No mutations.
// ---------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { buildRuntimeValidationReport } from "./logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function run() {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  return buildRuntimeValidationReport({
    async listOrphanedRuns(olderThanIso) {
      const { data } = await sb
        .from("workflow_runs")
        .select("id, workflow_name, started_at, state")
        .not("state", "in", "(completed,failed)")
        .lt("started_at", olderThanIso)
        .limit(25);
      return data ?? [];
    },
    async listStaleLeases(nowIso) {
      const { data } = await sb
        .from("workflow_jobs")
        .select("id, run_id, state, lease_expires_at, worker_id")
        .in("state", ["claimed", "running"])
        .lt("lease_expires_at", nowIso)
        .limit(25);
      return data ?? [];
    },
    async listOfflineWorkerCounters() {
      const { data } = await sb
        .from("worker_registry")
        .select("worker_id, active_jobs, health_state, last_heartbeat")
        .eq("health_state", "offline")
        .gt("active_jobs", 0)
        .limit(25);
      return data ?? [];
    },
    async listStaleHeartbeats(olderThanIso) {
      const { data } = await sb
        .from("worker_registry")
        .select("worker_id, last_heartbeat, health_state")
        .eq("health_state", "active")
        .lt("last_heartbeat", olderThanIso)
        .limit(25);
      return data ?? [];
    },
    async listRecentDeadLetters(sinceIso) {
      const { data } = await sb
        .from("workflow_dead_letter")
        .select("id, run_id, dag_node_id, last_error, moved_at")
        .gt("moved_at", sinceIso)
        .limit(25);
      return data ?? [];
    },
    async listRecentCompletedRuns(sinceIso) {
      const { data } = await sb
        .from("workflow_runs")
        .select("id, workflow_name")
        .eq("state", "completed")
        .gt("ended_at", sinceIso)
        .limit(200);
      return data ?? [];
    },
    async listCheckpointsForRuns(runIds) {
      const { data } = await sb
        .from("workflow_checkpoints")
        .select("run_id")
        .in("run_id", runIds);
      return data ?? [];
    },
    async listOpenBreaches() {
      const { data } = await sb
        .from("sla_breaches")
        .select("id, run_id, target, observed_ms, budget_ms")
        .is("resolved_at", null)
        .limit(100);
      return data ?? [];
    },
    async listSlaIncidents(runIds) {
      const { data } = await sb
        .from("workflow_incidents")
        .select("run_id")
        .in("run_id", runIds)
        .eq("category", "sla_breach");
      return data ?? [];
    },
    async listQueuePressureJobs(olderThanIso) {
      const { data } = await sb
        .from("workflow_jobs")
        .select("id, state, scheduled_at, partition_key, priority_class")
        .in("state", ["queued", "retrying"])
        .lt("scheduled_at", olderThanIso)
        .limit(25);
      return data ?? [];
    },
    async countActiveRuns() {
      const { count } = await sb
        .from("workflow_runs")
        .select("id", { count: "exact", head: true })
        .not("state", "in", "(completed,failed)");
      return count ?? 0;
    },
    async countRecentEvents(sinceIso) {
      const { count } = await sb
        .from("workflow_events")
        .select("id", { count: "exact", head: true })
        .gt("ts", sinceIso);
      return count ?? 0;
    },
    async listExpiredApprovals(nowIso) {
      const { data } = await sb
        .from("workflow_approvals")
        .select("id, run_id, expires_at")
        .eq("state", "pending")
        .lt("expires_at", nowIso)
        .limit(25);
      return data ?? [];
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const report = await run();
    return new Response(JSON.stringify(report), {
      headers: { ...cors, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...cors, "content-type": "application/json" },
    });
  }
});
