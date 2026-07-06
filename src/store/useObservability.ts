import { create } from "zustand";
import { supabase } from "@/integrations/supabase/client";
import {
  buildObservabilityBindings,
  requireTenantId,
  resolveTenantScope,
} from "@/lib/tenantScope";

export interface SlaBreachRow {
  id: string;
  run_id: string | null;
  scope: string;
  target: string;
  observed_ms: number;
  budget_ms: number;
  severity: string;
  detected_at: string;
  resolved_at: string | null;
}

export interface HeartbeatRow {
  worker_id: string;
  last_seen_at: string;
  jobs_processed: number;
  status: string;
}

interface State {
  breaches: SlaBreachRow[];
  heartbeats: HeartbeatRow[];
  queueDepth: number;
  hydrate: () => Promise<void>;
  subscribe: () => () => void;
}

export const useObservability = create<State>((set) => ({
  breaches: [],
  heartbeats: [],
  queueDepth: 0,
  hydrate: async () => {
    const scope = await resolveTenantScope();
    const tenantId = requireTenantId(scope);
    const [b, h, q] = await Promise.all([
      supabase.from("sla_breaches").select("*").eq("tenant_id", tenantId).order("detected_at", { ascending: false }).limit(20),
      scope.isAdmin
        ? supabase.from("worker_heartbeats").select("*").order("last_seen_at", { ascending: false }).limit(10)
        : Promise.resolve({ data: [], error: null }),
      supabase.from("workflow_jobs").select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("state", ["queued", "retrying", "delayed", "claimed", "running"]),
    ]);
    set({
      breaches: (b.data ?? []) as SlaBreachRow[],
      heartbeats: (h.data ?? []) as HeartbeatRow[],
      queueDepth: q.count ?? 0,
    });
  },
  subscribe: () => {
    let disposed = false;
    let cleanup = () => {};

    void resolveTenantScope().then((scope) => {
      if (disposed) return;
      const bindings = buildObservabilityBindings(scope);
      const channel = supabase.channel(`observability_stream:${scope.tenantId ?? "none"}`);
      for (const binding of bindings) {
        channel.on("postgres_changes", {
          event: "*",
          schema: "public",
          table: binding.table,
          ...(binding.filter ? { filter: binding.filter } : {}),
        }, () => useObservability.getState().hydrate());
      }
      channel.subscribe();
      const iv = setInterval(() => useObservability.getState().hydrate(), 15_000);
      cleanup = () => {
        supabase.removeChannel(channel);
        clearInterval(iv);
      };
    });

    return () => {
      disposed = true;
      cleanup();
    };
  },
}));
