import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { Activity, AlertTriangle, ChevronRight, Clock, GitCompareArrows, Layers, RefreshCw, Search, Workflow } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

interface RunRow {
  id: string; workflow_name: string; status: string;
  duration_ms: number | null; error: string | null;
  started_at: string; workflow_version_id?: string | null;
}
interface StepRow { id: string; run_id: string; step_index: number; name: string; state: string; duration_ms: number | null; attempt?: number; started_at?: string; finished_at?: string; }
interface EventRow { id: string; run_id: string; ts: string; type: string; message: string; step_id?: string | null; }
interface CheckpointRow { id: string; run_id: string; ts: string; step_index: number | null; label?: string | null; }

const STATE_TONE: Record<string, string> = {
  succeeded: "text-success", completed: "text-success",
  failed: "text-destructive", error: "text-destructive",
  running: "text-primary", queued: "text-muted-foreground",
  retrying: "text-warning",
};

function fmt(ts?: string | null) { return ts ? new Date(ts).toLocaleTimeString() : "—"; }
function fmtDur(ms?: number | null) { return ms == null ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`; }

export default function RuntimeInspector() {
  const { user } = useAuth();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointRow[]>([]);
  const [filter, setFilter] = useState("");
  const [compareId, setCompareId] = useState<string | null>(null);
  const [compareSteps, setCompareSteps] = useState<StepRow[]>([]);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("workflow_runs")
      .select("id, workflow_name, status, duration_ms, error, started_at, workflow_version_id")
      .order("started_at", { ascending: false })
      .limit(80);
    const rows = (data ?? []) as RunRow[];
    setRuns(rows);
    if (!selectedId && rows[0]) setSelectedId(rows[0].id);
    setLoading(false);
  }, [selectedId]);

  const loadDetail = useCallback(async (runId: string, target: "primary" | "compare" = "primary") => {
    const [stepsRes, evtRes, ckpRes] = await Promise.all([
      supabase.from("workflow_step_runs").select("*").eq("run_id", runId).order("step_index", { ascending: true }),
      supabase.from("workflow_events").select("*").eq("run_id", runId).order("ts", { ascending: true }).limit(500),
      supabase.from("workflow_checkpoints").select("*").eq("run_id", runId).order("ts", { ascending: true }),
    ]);
    if (target === "primary") {
      setSteps((stepsRes.data ?? []) as StepRow[]);
      setEvents((evtRes.data ?? []) as EventRow[]);
      setCheckpoints((ckpRes.data ?? []) as CheckpointRow[]);
    } else {
      setCompareSteps((stepsRes.data ?? []) as StepRow[]);
    }
  }, []);

  useEffect(() => { if (user) void loadRuns(); }, [user, loadRuns]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId, "primary"); }, [selectedId, loadDetail]);
  useEffect(() => { if (compareId) void loadDetail(compareId, "compare"); else setCompareSteps([]); }, [compareId, loadDetail]);

  // Realtime subscription on selected run
  useEffect(() => {
    if (!selectedId) return;
    const ch = supabase.channel(`inspect_${selectedId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "workflow_step_runs", filter: `run_id=eq.${selectedId}` }, () => loadDetail(selectedId))
      .on("postgres_changes", { event: "*", schema: "public", table: "workflow_events", filter: `run_id=eq.${selectedId}` }, () => loadDetail(selectedId))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [selectedId, loadDetail]);

  const run = runs.find((r) => r.id === selectedId) ?? null;
  const filteredRuns = useMemo(() => {
    const q = filter.toLowerCase();
    return runs.filter((r) => !q || r.workflow_name?.toLowerCase().includes(q) || r.id.includes(q) || r.status.toLowerCase().includes(q));
  }, [runs, filter]);

  const totalDuration = steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0) || 1;
  const retries = events.filter((e) => /retry/i.test(e.type)).length;
  const failures = events.filter((e) => /fail|error/i.test(e.type)).length;
  const candidatesForCompare = runs.filter((r) => r.id !== selectedId && r.workflow_name === run?.workflow_name).slice(0, 10);

  if (!user) {
    return (
      <div className="px-6 lg:px-8 py-6 max-w-7xl mx-auto">
        <PageHeader title="Runtime Inspector" description="Black-box flight recorder for workflow executions." />
        <EmptyState icon={<Activity className="h-5 w-5" />} title="Sign in required"
          description="Runtime inspection is scoped to your tenant. Sign in to access execution forensics."
          action={<Button asChild size="sm"><Link to="/auth">Sign in</Link></Button>} />
      </div>
    );
  }

  return (
    <div className="px-6 lg:px-8 py-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Runtime Inspector"
        description="Per-run forensics: step timeline, retries, checkpoints, decisions, and lineage."
        actions={
          <Button variant="outline" size="sm" onClick={loadRuns} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-12 gap-4">
        <Card className="col-span-3">
          <CardHeader className="py-3">
            <CardTitle className="text-xs uppercase tracking-wide flex items-center gap-1.5">
              <Workflow className="h-3.5 w-3.5" /> Recent runs
            </CardTitle>
            <div className="relative mt-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter…" className="pl-7 h-7 text-xs" />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="h-[640px] pr-2">
              {filteredRuns.length === 0 && <div className="text-xs text-muted-foreground py-6 text-center">No runs match.</div>}
              {filteredRuns.map((r) => {
                const sel = selectedId === r.id;
                return (
                  <button key={r.id} onClick={() => setSelectedId(r.id)}
                    className={`w-full text-left px-2 py-2 rounded mb-1 transition-colors ${sel ? "bg-primary/10 border border-primary/40" : "hover:bg-accent/50 border border-transparent"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium truncate">{r.workflow_name || "untitled"}</span>
                      <span className={`text-[10px] font-mono ${STATE_TONE[r.status] ?? "text-muted-foreground"}`}>●</span>
                    </div>
                    <div className="flex items-center justify-between mt-1 text-[10px] font-mono text-muted-foreground">
                      <span className="truncate">{r.id.slice(0, 8)}</span>
                      <span className="tabular-nums">{fmtDur(r.duration_ms)}</span>
                    </div>
                  </button>
                );
              })}
            </ScrollArea>
          </CardContent>
        </Card>

        <div className="col-span-9 space-y-4">
          {!run ? (
            <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">Select a run to inspect.</CardContent></Card>
          ) : (
            <>
              <Card>
                <CardHeader className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-sm flex items-center gap-2 truncate">
                        {run.workflow_name}
                        <Badge variant="outline" className={`text-[10px] font-mono ${STATE_TONE[run.status] ?? ""}`}>{run.status}</Badge>
                      </CardTitle>
                      <div className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
                        run:{run.id} {run.workflow_version_id && `· version:${run.workflow_version_id.slice(0, 8)}`}
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-center shrink-0">
                      <Stat label="Duration" value={fmtDur(run.duration_ms)} />
                      <Stat label="Steps" value={String(steps.length)} />
                      <Stat label="Retries" value={String(retries)} tone={retries ? "warn" : undefined} />
                      <Stat label="Failures" value={String(failures)} tone={failures ? "err" : undefined} />
                    </div>
                  </div>
                </CardHeader>
              </Card>

              <Tabs defaultValue="timeline">
                <TabsList>
                  <TabsTrigger value="timeline" className="text-xs"><Clock className="h-3 w-3 mr-1.5" />Timeline</TabsTrigger>
                  <TabsTrigger value="events" className="text-xs"><Activity className="h-3 w-3 mr-1.5" />Events</TabsTrigger>
                  <TabsTrigger value="checkpoints" className="text-xs"><Layers className="h-3 w-3 mr-1.5" />Checkpoints</TabsTrigger>
                  <TabsTrigger value="compare" className="text-xs"><GitCompareArrows className="h-3 w-3 mr-1.5" />Compare</TabsTrigger>
                  <TabsTrigger value="rootcause" className="text-xs"><AlertTriangle className="h-3 w-3 mr-1.5" />Root cause</TabsTrigger>
                </TabsList>

                <TabsContent value="timeline" className="mt-3">
                  <Card><CardContent className="py-4">
                    {steps.length === 0 ? <div className="text-xs text-muted-foreground text-center py-8">No step records.</div> : (
                      <div className="space-y-1.5">
                        {steps.map((s) => {
                          const width = Math.max(1, ((s.duration_ms ?? 0) / totalDuration) * 100);
                          return (
                            <div key={s.id} className="grid grid-cols-12 items-center gap-2 text-[11px]">
                              <span className="col-span-3 font-mono truncate text-foreground/90">{s.step_index}. {s.name}</span>
                              <div className="col-span-7 h-5 bg-muted/40 rounded relative overflow-hidden">
                                <div className={`absolute inset-y-0 left-0 ${STATE_TONE[s.state]?.replace("text-", "bg-") ?? "bg-muted-foreground"} opacity-50`} style={{ width: `${width}%` }} />
                                <div className="absolute inset-0 flex items-center px-2">
                                  <span className={`font-mono text-[10px] uppercase tracking-wider ${STATE_TONE[s.state] ?? "text-muted-foreground"}`}>{s.state}</span>
                                  {(s.attempt ?? 1) > 1 && <span className="ml-2 text-[10px] font-mono text-warning">×{s.attempt}</span>}
                                </div>
                              </div>
                              <span className="col-span-2 text-right font-mono tabular-nums text-muted-foreground">{fmtDur(s.duration_ms)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent></Card>
                </TabsContent>

                <TabsContent value="events" className="mt-3">
                  <Card><CardContent className="p-0">
                    <ScrollArea className="h-[420px]">
                      {events.length === 0 ? <div className="text-xs text-muted-foreground text-center py-8">No events recorded.</div> : (
                        <ul className="divide-y divide-border/40">
                          {events.map((e) => (
                            <li key={e.id} className="grid grid-cols-12 gap-2 px-3 py-1.5 text-[11px]">
                              <span className="col-span-2 font-mono text-muted-foreground tabular-nums">{fmt(e.ts)}</span>
                              <span className="col-span-2 font-mono uppercase tracking-wider text-muted-foreground truncate">{e.type}</span>
                              <span className="col-span-8 text-foreground/90 truncate">{e.message}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </ScrollArea>
                  </CardContent></Card>
                </TabsContent>

                <TabsContent value="checkpoints" className="mt-3">
                  <Card><CardContent className="py-4">
                    {checkpoints.length === 0 ? <div className="text-xs text-muted-foreground text-center py-6">No checkpoints captured for this run.</div> : (
                      <div className="space-y-2">
                        {checkpoints.map((c) => (
                          <div key={c.id} className="flex items-center justify-between border border-border/50 rounded px-3 py-2 text-[11px]">
                            <div className="flex items-center gap-2">
                              <Layers className="h-3 w-3 text-accent" />
                              <span className="font-mono">step {c.step_index ?? "—"}</span>
                              {c.label && <span className="text-muted-foreground">· {c.label}</span>}
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="font-mono text-muted-foreground tabular-nums">{new Date(c.ts).toLocaleString()}</span>
                              <Button variant="outline" size="sm" className="h-6 text-[10px]"
                                onClick={async () => {
                                  const { error } = await supabase.functions.invoke("replay-workflow", { body: { source_run_id: run.id, from_checkpoint: c.id } });
                                  if (error) toast.error("Replay failed", { description: error.message });
                                  else toast.success("Replay dispatched from checkpoint");
                                }}>
                                Replay from here
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent></Card>
                </TabsContent>

                <TabsContent value="compare" className="mt-3">
                  <Card>
                    <CardHeader className="py-3">
                      <CardTitle className="text-xs uppercase tracking-wide">Diff against another run</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap gap-1.5">
                        {candidatesForCompare.length === 0 && <span className="text-[11px] text-muted-foreground">No other runs of this workflow.</span>}
                        {candidatesForCompare.map((c) => (
                          <button key={c.id} onClick={() => setCompareId(c.id === compareId ? null : c.id)}
                            className={`px-2 py-1 rounded border font-mono text-[10px] ${compareId === c.id ? "border-accent bg-accent/10" : "border-border text-muted-foreground hover:border-accent/60"}`}>
                            {c.id.slice(0, 8)} · {fmtDur(c.duration_ms)}
                          </button>
                        ))}
                      </div>
                      {compareId && (
                        <div className="space-y-1">
                          {steps.map((s) => {
                            const other = compareSteps.find((x) => x.name === s.name);
                            const a = s.duration_ms ?? 0; const b = other?.duration_ms ?? 0;
                            const delta = a - b;
                            const tone = !other ? "text-muted-foreground" : delta > 0 ? "text-warning" : delta < 0 ? "text-success" : "text-muted-foreground";
                            return (
                              <div key={s.id} className="grid grid-cols-12 items-center gap-2 text-[11px] py-1 border-b border-border/30">
                                <span className="col-span-4 font-mono truncate">{s.name}</span>
                                <span className="col-span-2 text-right font-mono tabular-nums">{fmtDur(a)}</span>
                                <ChevronRight className="col-span-1 h-3 w-3 mx-auto text-muted-foreground" />
                                <span className="col-span-2 text-right font-mono tabular-nums">{other ? fmtDur(b) : "—"}</span>
                                <span className={`col-span-2 text-right font-mono tabular-nums ${tone}`}>{other ? `${delta >= 0 ? "+" : ""}${delta}ms` : "n/a"}</span>
                                <span className={`col-span-1 text-right font-mono text-[10px] ${STATE_TONE[s.state] ?? "text-muted-foreground"}`}>{s.state}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="rootcause" className="mt-3">
                  <Card><CardContent className="py-4 space-y-3">
                    {run.error || run.status === "failed" ? (
                      <>
                        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] font-mono text-destructive">
                          {run.error ?? "Run reported failed state without an error message."}
                        </div>
                        <div className="text-[11px] text-muted-foreground">First failing step:</div>
                        {(() => {
                          const fail = steps.find((s) => s.state === "failed" || s.state === "error");
                          if (!fail) return <div className="text-[11px] text-muted-foreground">No step recorded a terminal failure (likely orchestration-level).</div>;
                          const relatedEvents = events.filter((e) => e.step_id === fail.id || e.message?.includes(fail.name));
                          return (
                            <div className="border border-border/50 rounded p-2 space-y-1.5">
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="font-mono">{fail.step_index}. {fail.name}</span>
                                <span className="font-mono text-muted-foreground">{fmtDur(fail.duration_ms)} · ×{fail.attempt ?? 1}</span>
                              </div>
                              <ul className="text-[11px] font-mono space-y-0.5">
                                {relatedEvents.slice(-10).map((e) => (
                                  <li key={e.id} className="text-muted-foreground"><span className="text-foreground/70">{e.type}</span> — {e.message}</li>
                                ))}
                              </ul>
                            </div>
                          );
                        })()}
                      </>
                    ) : (
                      <div className="text-[12px] text-muted-foreground text-center py-6">Run did not fail — no root cause analysis required.</div>
                    )}
                  </CardContent></Card>
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "err" }) {
  const cls = tone === "err" ? "text-destructive" : tone === "warn" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded border border-border bg-muted/30 px-2 py-1.5 min-w-[68px]">
      <div className={`font-mono text-sm tabular-nums ${cls}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}
