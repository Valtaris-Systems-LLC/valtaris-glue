// Mission Control: live scale & infrastructure telemetry stream
import { create } from "zustand";
import { supabase } from "@/integrations/supabase/client";

interface PressureRow {
  id: string; captured_at: string; queued: number; retrying: number;
  delayed: number; in_flight: number; dead_letter: number;
  pressure_score: number; recommendation: string | null;
}
interface WorkerSnap {
  id: string; captured_at: string; worker_id: string; region: string | null;
  active_jobs: number; max_concurrency: number; saturation: number; health_state: string;
}
interface Breaker {
  connector: string; state: string; failure_count: number;
  next_attempt_at: string | null; last_transition_at: string;
}
interface Span {
  id: string; trace_id: string; name: string; kind: string;
  duration_ms: number | null; status: string; started_at: string;
}
interface Benchmark {
  id: string; name: string; scenario: string; state: string;
  total_runs: number; completed_runs: number; failed_runs: number;
  throughput_per_sec: number | null; duration_ms: number | null; started_at: string;
}

interface State {
  pressure: PressureRow[];
  workers: WorkerSnap[];
  breakers: Breaker[];
  spans: Span[];
  benchmarks: Benchmark[];
  loading: boolean;
  refresh: () => Promise<void>;
  runLoadTest: (runs?: number, concurrency?: number) => Promise<void>;
  captureScale: () => Promise<void>;
}

export const useScaleOps = create<State>((set, get) => ({
  pressure: [], workers: [], breakers: [], spans: [], benchmarks: [], loading: false,
  refresh: async () => {
    set({ loading: true });
    const [p, w, b, s, bm] = await Promise.all([
      supabase.from("queue_pressure_signals").select("*").order("captured_at", { ascending: false }).limit(30),
      supabase.from("worker_capacity_snapshots").select("*").order("captured_at", { ascending: false }).limit(50),
      supabase.from("connector_circuit_breakers").select("*").order("last_transition_at", { ascending: false }),
      supabase.from("trace_spans").select("id,trace_id,name,kind,duration_ms,status,started_at")
        .order("started_at", { ascending: false }).limit(40),
      supabase.from("load_benchmarks").select("*").order("started_at", { ascending: false }).limit(10),
    ]);
    set({
      pressure: (p.data ?? []) as PressureRow[],
      workers: (w.data ?? []) as WorkerSnap[],
      breakers: (b.data ?? []) as Breaker[],
      spans: (s.data ?? []) as Span[],
      benchmarks: (bm.data ?? []) as Benchmark[],
      loading: false,
    });
  },
  captureScale: async () => {
    await supabase.functions.invoke("scale-monitor", { body: {} });
    await get().refresh();
  },
  runLoadTest: async (runs = 20, concurrency = 5) => {
    await supabase.functions.invoke("load-harness", { body: { runs, concurrency } });
    await get().refresh();
  },
}));
