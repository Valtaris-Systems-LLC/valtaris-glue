import { create } from "zustand";
import { supabase } from "@/integrations/supabase/client";
import { buildLiveRunsBindings, requireTenantId, resolveTenantScope } from "@/lib/tenantScope";
import type { WorkflowRun, RunState } from "@/runtime/types";

const MAX = 100;
const TERMINAL: RunState[] = ["completed", "failed"];

interface LiveRunsState {
  runs: WorkflowRun[];
  connected: boolean;
  hydrate: () => Promise<void>;
  subscribe: () => () => void;
}

function upsert(list: WorkflowRun[], next: WorkflowRun): WorkflowRun[] {
  const idx = list.findIndex((r) => r.id === next.id);
  if (idx === -1) return [next, ...list].slice(0, MAX);
  const copy = list.slice();
  copy[idx] = { ...copy[idx], ...next };
  return copy;
}

export const useLiveRuns = create<LiveRunsState>((set, get) => ({
  runs: [],
  connected: false,

  hydrate: async () => {
    const scope = await resolveTenantScope({ dagId: "demo.live" });
    const tenantId = requireTenantId(scope);
    const { data, error } = await supabase
      .from("workflow_runs")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("started_at", { ascending: false })
      .limit(MAX);
    if (error) {
      console.error("[live-runs] hydrate failed", error);
      return;
    }
    set({ runs: (data ?? []) as unknown as WorkflowRun[] });
  },

  subscribe: () => {
    let disposed = false;
    let cleanup = () => {};

    void resolveTenantScope({ dagId: "demo.live" }).then((scope) => {
      if (disposed) return;
      const [binding] = buildLiveRunsBindings(scope);
      if (!binding) {
        set({ connected: false, runs: [] });
        return;
      }

      const channel = supabase
        .channel(`workflow_runs_stream:${scope.tenantId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: binding.table, filter: binding.filter },
          (payload) => {
            const row = payload.new as unknown as WorkflowRun | undefined;
            if (!row) return;
            set({ runs: upsert(get().runs, row) });
          }
        )
        .subscribe((status) => set({ connected: status === "SUBSCRIBED" }));

      cleanup = () => {
        supabase.removeChannel(channel);
        set({ connected: false });
      };
    });

    return () => {
      disposed = true;
      cleanup();
    };
  },
}));

export function aggregateRuns(runs: WorkflowRun[]) {
  const now = Date.now();
  const windowMs = 60_000;
  const recent = runs.filter((r) => now - new Date(r.started_at).getTime() < 5 * 60_000);

  const active = runs.filter((r) => !TERMINAL.includes(r.state as RunState)).length;
  const queued = runs.filter((r) => r.state === "queued" || r.state === "scheduled").length;
  const retrying = runs.filter((r) => r.state === "retrying").length;
  const failed = runs.filter((r) => r.state === "failed").length;
  const completed = runs.filter((r) => r.state === "completed").length;
  const throughputPerMin =
    recent.filter((r) => TERMINAL.includes(r.state as RunState)).length /
    Math.max(1, Math.min(5, recent.length ? 5 : 1));

  const completedRecent = recent.filter((r) => r.state === "completed" && r.duration_ms);
  const avgDurationMs =
    completedRecent.length > 0
      ? Math.round(
          completedRecent.reduce((a, r) => a + (r.duration_ms ?? 0), 0) /
            completedRecent.length
        )
      : 0;
  const successRate =
    completed + failed > 0 ? Math.round((completed / (completed + failed)) * 100) : 100;

  return {
    active,
    queued,
    retrying,
    failed,
    completed,
    throughputPerMin: Math.round(throughputPerMin * 10) / 10,
    avgDurationMs,
    successRate,
    windowMs,
  };
}
