import { useEffect, useMemo, useState } from "react";
import { useReliability, analyzeWorkflows, analyzeSteps, analyzeConnectors, detectAnomalies, mapDependencies, reviewReadiness, executiveSummary } from "@/store/useReliability";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StatCard } from "@/components/ui/stat-card";
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Boxes, CheckCircle2, GitBranch, ShieldCheck, Sparkles, TrendingDown, TrendingUp, XCircle } from "lucide-react";
import { toast } from "sonner";

function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 80 ? "success" : score >= 60 ? "warning" : "danger";
  const cls = tone === "success" ? "text-success border-success/40" : tone === "warning" ? "text-warning border-warning/40" : "text-danger border-danger/40";
  return <Badge variant="outline" className={`tabular-nums ${cls}`}>{score}</Badge>;
}

function fmtMs(ms: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

type KnowledgeEntry = {
  definition_id: string;
  purpose: string | null;
  owner: string | null;
  business_outcome: string | null;
  known_risks: string | null;
  operational_notes: string | null;
};

export default function Reliability() {
  const { user } = useAuth();
  const load = useReliability((s) => s.load);
  const loaded = useReliability((s) => s.loaded);
  const loading = useReliability((s) => s.loading);
  const runs = useReliability((s) => s.runs);
  const steps = useReliability((s) => s.steps);
  const definitions = useReliability((s) => s.definitions);
  const versions = useReliability((s) => s.versions);
  const knowledge = useReliability((s) => s.knowledge);
  const breakers = useReliability((s) => s.breakers);
  const approvals = useReliability((s) => s.approvals);
  const rollbacks = useReliability((s) => s.rollbacks);
  const persistedAnomalies = useReliability((s) => s.anomalies);
  const saveKnowledge = useReliability((s) => s.saveKnowledge);
  const recordAnomaly = useReliability((s) => s.recordAnomaly);

  useEffect(() => { void load(); }, [load]);

  const workflowAnalysis = useMemo(() => analyzeWorkflows(runs), [runs]);
  const stepAnalysis = useMemo(() => analyzeSteps(steps), [steps]);
  const connectorAnalysis = useMemo(() => analyzeConnectors(steps, breakers), [steps, breakers]);
  const liveAnomalies = useMemo(() => detectAnomalies(runs, steps, breakers, approvals), [runs, steps, breakers, approvals]);
  const dependencies = useMemo(() => mapDependencies(definitions, versions, breakers, connectorAnalysis), [definitions, versions, breakers, connectorAnalysis]);
  const readiness = useMemo(() => reviewReadiness(definitions, versions, dependencies, knowledge), [definitions, versions, dependencies, knowledge]);
  const exec = useMemo(() => executiveSummary(runs, workflowAnalysis, connectorAnalysis, breakers), [runs, workflowAnalysis, connectorAnalysis, breakers]);

  const mostFragile = workflowAnalysis.slice(0, 5);
  const mostReliable = [...workflowAnalysis].sort((a, b) => b.score - a.score).slice(0, 5);

  const persistLiveAnomalies = async () => {
    const tenant = runs[0]?.tenant_id ?? null;
    let n = 0;
    let failed = 0;
    for (const a of liveAnomalies) {
      try {
        await recordAnomaly({ kind: a.kind, severity: a.severity, scope: a.scope, subject: a.subject, metric_value: null, baseline_value: null, explanation: a.explanation, evidence: a.evidence }, tenant);
        n++;
      } catch {
        failed++;
      }
    }
    toast.success(`Recorded ${n} anomaly event${n === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}`);
  };

  return (
    <div className="px-6 lg:px-8 py-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Reliability Center"
        description="Trusted workflow operations: success, behavior, anomalies, dependencies, readiness, and executive view — every score is explainable."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Success rate (7d)" value={`${Math.round(exec.successRate * 100)}%`} tone={exec.successRate >= 0.95 ? "success" : exec.successRate >= 0.85 ? "warning" : "danger"} icon={<CheckCircle2 className="h-4 w-4" />} hint={`${exec.totalRuns} runs`} />
        <StatCard label="Workflows healthy" value={`${exec.workflowsHealthy}/${exec.automationCoverage}`} tone="info" icon={<Activity className="h-4 w-4" />} hint={`${exec.workflowsAtRisk} at risk`} />
        <StatCard label="Connector health" value={`${Math.round(exec.connectorHealthAvg)}`} tone={exec.connectorHealthAvg >= 80 ? "success" : "warning"} icon={<Boxes className="h-4 w-4" />} hint={`${exec.openIncidents} breaker(s) open`} />
        <StatCard label="Reliability trend" value={exec.trend} tone={exec.trend === "improving" ? "success" : exec.trend === "degrading" ? "danger" : "neutral"} icon={exec.trend === "improving" ? <TrendingUp className="h-4 w-4" /> : exec.trend === "degrading" ? <TrendingDown className="h-4 w-4" /> : <Activity className="h-4 w-4" />} hint="24h vs prior 24h" />
      </div>

      <Tabs defaultValue="execution" className="w-full">
        <TabsList className="grid grid-cols-4 lg:grid-cols-8 h-auto">
          <TabsTrigger value="execution" className="text-xs">Execution</TabsTrigger>
          <TabsTrigger value="behavior" className="text-xs">Behavior</TabsTrigger>
          <TabsTrigger value="anomaly" className="text-xs">Anomalies</TabsTrigger>
          <TabsTrigger value="dependency" className="text-xs">Dependencies</TabsTrigger>
          <TabsTrigger value="connector" className="text-xs">Connectors</TabsTrigger>
          <TabsTrigger value="readiness" className="text-xs">Readiness</TabsTrigger>
          <TabsTrigger value="knowledge" className="text-xs">Knowledge</TabsTrigger>
          <TabsTrigger value="exec" className="text-xs">Executive</TabsTrigger>
        </TabsList>

        {/* MODULE 1 */}
        <TabsContent value="execution" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="py-3"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning" />Most fragile workflows</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {mostFragile.length === 0 && <div className="text-xs text-muted-foreground">No workflow runs in window.</div>}
                {mostFragile.map((w) => (
                  <div key={w.workflow_name} className="border border-border rounded p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium truncate">{w.workflow_name}</div>
                      <ScoreBadge score={w.score} />
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-[10px] text-muted-foreground font-mono">
                      <div><div>Runs</div><div className="text-foreground tabular-nums">{w.runs}</div></div>
                      <div><div>Success</div><div className="text-foreground tabular-nums">{Math.round(w.successRate * 100)}%</div></div>
                      <div><div>Retry</div><div className="text-foreground tabular-nums">{Math.round(w.retryRate * 100)}%</div></div>
                      <div><div>p95</div><div className="text-foreground tabular-nums">{fmtMs(w.p95DurationMs)}</div></div>
                    </div>
                    <ul className="text-[11px] text-muted-foreground space-y-0.5">
                      {w.rationale.map((r, i) => <li key={i}>• {r}</li>)}
                    </ul>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="py-3"><CardTitle className="text-sm flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" />Most reliable workflows</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {mostReliable.map((w) => (
                  <div key={w.workflow_name} className="border border-border rounded p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium truncate">{w.workflow_name}</div>
                      <ScoreBadge score={w.score} />
                    </div>
                    <div className="text-[11px] text-muted-foreground">{w.rationale[0]}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="py-3"><CardTitle className="text-sm">Failure concentration</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-3 text-xs">
                <div><div className="text-muted-foreground">Retries</div><div className="font-display text-2xl tabular-nums">{runs.filter((r) => (r.retry_count ?? 0) > 0).length}</div></div>
                <div><div className="text-muted-foreground">Rollbacks</div><div className="font-display text-2xl tabular-nums">{rollbacks.length}</div></div>
                <div><div className="text-muted-foreground">Replays</div><div className="font-display text-2xl tabular-nums">{runs.filter((r) => r.state === "replaying").length}</div></div>
                <div><div className="text-muted-foreground">Failures</div><div className="font-display text-2xl tabular-nums text-danger">{runs.filter((r) => r.state === "failed").length}</div></div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* MODULE 2 */}
        <TabsContent value="behavior" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="py-3"><CardTitle className="text-sm">Step-level behavior report</CardTitle></CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="text-left py-2">Step</th>
                      <th className="text-left">Connector</th>
                      <th className="text-right">Runs</th>
                      <th className="text-right">Fails</th>
                      <th className="text-right">Retries</th>
                      <th className="text-right">Avg</th>
                      <th className="text-right">p95</th>
                      <th className="text-left pl-3">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stepAnalysis.slice(0, 80).map((s, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-1.5 truncate max-w-[200px]">{s.name}</td>
                        <td className="font-mono text-muted-foreground">{s.connector ?? "—"}</td>
                        <td className="text-right tabular-nums">{s.runs}</td>
                        <td className="text-right tabular-nums text-danger">{s.failures || ""}</td>
                        <td className="text-right tabular-nums">{s.retries || ""}</td>
                        <td className="text-right tabular-nums">{fmtMs(s.avgDurationMs)}</td>
                        <td className="text-right tabular-nums">{fmtMs(s.p95DurationMs)}</td>
                        <td className="pl-3"><div className="flex gap-1 flex-wrap">{s.flags.map((f) => <Badge key={f} variant="outline" className="text-[9px] px-1 py-0">{f}</Badge>)}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {stepAnalysis.length === 0 && <div className="text-xs text-muted-foreground py-6 text-center">No step telemetry in window.</div>}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* MODULE 3 */}
        <TabsContent value="anomaly" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="py-3 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">Live anomalies</CardTitle>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={liveAnomalies.length === 0} onClick={persistLiveAnomalies}>Record events</Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {liveAnomalies.length === 0 && <div className="text-xs text-muted-foreground">No anomalies detected in the current window.</div>}
              {liveAnomalies.map((a, i) => (
                <div key={i} className="border border-border rounded p-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={a.severity === "critical" ? "destructive" : "outline"} className="text-[9px] px-1 py-0">{a.severity}</Badge>
                    <span className="text-xs font-mono">{a.kind}</span>
                    <span className="text-[10px] text-muted-foreground">· {a.scope} · {a.subject}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">{a.explanation}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3"><CardTitle className="text-sm">Recorded anomaly events</CardTitle></CardHeader>
            <CardContent>
              <ScrollArea className="h-[300px]">
                {persistedAnomalies.length === 0 && <div className="text-xs text-muted-foreground">No persisted anomalies yet.</div>}
                {persistedAnomalies.map((a) => (
                  <div key={a.id} className="text-[11px] py-1.5 border-b border-border/50">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-muted-foreground">{new Date(a.detected_at).toLocaleString()}</span>
                      <Badge variant={a.severity === "critical" ? "destructive" : "outline"} className="text-[9px] px-1 py-0">{a.severity}</Badge>
                      <span className="font-mono">{a.kind}</span>
                    </div>
                    <div className="text-muted-foreground mt-0.5">{a.explanation}</div>
                  </div>
                ))}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* MODULE 4 */}
        <TabsContent value="dependency" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="py-3"><CardTitle className="text-sm">Workflow dependency intelligence</CardTitle></CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                {dependencies.map((d) => (
                  <div key={d.definition_id} className="border border-border rounded p-3 mb-2">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium">{d.workflow_name}</div>
                      <Badge variant="outline" className={d.risk === "high" ? "text-danger border-danger/40" : d.risk === "medium" ? "text-warning border-warning/40" : "text-success border-success/40"}>{d.risk} risk</Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-[11px]">
                      <div>
                        <div className="text-[10px] uppercase text-muted-foreground mb-1">Connectors ({d.connectors.length})</div>
                        <div className="flex flex-wrap gap-1">{d.connectors.length ? d.connectors.map((c) => <Badge key={c} variant="outline" className="text-[10px] px-1 py-0">{c}</Badge>) : <span className="text-muted-foreground">none</span>}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-muted-foreground mb-1">Secrets ({d.secrets.length})</div>
                        <div className="flex flex-wrap gap-1">{d.secrets.length ? d.secrets.map((s) => <Badge key={s} variant="outline" className="text-[10px] px-1 py-0 font-mono">{s}</Badge>) : <span className="text-muted-foreground">none declared</span>}</div>
                      </div>
                    </div>
                    <ul className="text-[11px] text-muted-foreground mt-2 space-y-0.5">{d.rationale.map((r, i) => <li key={i}>• {r}</li>)}</ul>
                  </div>
                ))}
                {dependencies.length === 0 && <div className="text-xs text-muted-foreground">No workflow definitions yet.</div>}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* MODULE 5 */}
        <TabsContent value="connector" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="py-3"><CardTitle className="text-sm">Connector reliability scores</CardTitle></CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                {connectorAnalysis.length === 0 && <div className="text-xs text-muted-foreground">No connector telemetry yet.</div>}
                {connectorAnalysis.map((c) => (
                  <div key={c.connector} className="border border-border rounded p-3 mb-2">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-mono">{c.connector}</div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{c.breakerState}</Badge>
                        <ScoreBadge score={c.score} />
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-[10px] text-muted-foreground font-mono mb-2">
                      <div><div>Calls</div><div className="text-foreground tabular-nums">{c.invocations}</div></div>
                      <div><div>Failures</div><div className="text-foreground tabular-nums">{c.failures}</div></div>
                      <div><div>Retries</div><div className="text-foreground tabular-nums">{c.retries}</div></div>
                      <div><div>Avg latency</div><div className="text-foreground tabular-nums">{fmtMs(c.avgLatencyMs)}</div></div>
                    </div>
                    <Progress value={c.score} className="h-1.5" />
                    <ul className="text-[11px] text-muted-foreground mt-2 space-y-0.5">{c.rationale.map((r, i) => <li key={i}>• {r}</li>)}</ul>
                  </div>
                ))}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* MODULE 6 */}
        <TabsContent value="readiness" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="py-3"><CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Pre-publish readiness review</CardTitle></CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                {readiness.map((r) => (
                  <div key={r.definition_id} className="border border-border rounded p-3 mb-2">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium">{r.workflow_name}</div>
                      <Badge variant="outline" className={r.verdict === "PASS" ? "text-success border-success/40" : r.verdict === "WARNING" ? "text-warning border-warning/40" : "text-danger border-danger/40"}>{r.verdict}</Badge>
                    </div>
                    {r.findings.length === 0 ? (
                      <div className="text-[11px] text-success">All checks passed.</div>
                    ) : (
                      <ul className="space-y-1">
                        {r.findings.map((f, i) => (
                          <li key={i} className="text-[11px] flex gap-2">
                            {f.level === "error" ? <XCircle className="h-3 w-3 text-danger shrink-0 mt-0.5" /> : f.level === "warning" ? <AlertTriangle className="h-3 w-3 text-warning shrink-0 mt-0.5" /> : <Sparkles className="h-3 w-3 text-info shrink-0 mt-0.5" />}
                            <div>
                              <div className="text-foreground">{f.message}</div>
                              <div className="text-muted-foreground">{f.reason}</div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
                {readiness.length === 0 && <div className="text-xs text-muted-foreground">No workflows to review.</div>}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* MODULE 7 */}
        <TabsContent value="knowledge" className="space-y-4 mt-4">
          <KnowledgeEditor
            definitions={definitions}
            knowledge={knowledge}
            onSave={async (input) => {
              try { await saveKnowledge(input); toast.success("Knowledge updated"); }
              catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); }
            }}
          />
        </TabsContent>

        {/* MODULE 8 */}
        <TabsContent value="exec" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Runs (7d)" value={exec.totalRuns} tone="info" icon={<Activity className="h-4 w-4" />} />
            <StatCard label="Workflow success" value={`${Math.round(exec.successRate * 100)}%`} tone={exec.successRate >= 0.95 ? "success" : "warning"} icon={<CheckCircle2 className="h-4 w-4" />} />
            <StatCard label="Healthy automations" value={exec.workflowsHealthy} tone="success" icon={<GitBranch className="h-4 w-4" />} hint={`${exec.workflowsAtRisk} at risk`} />
            <StatCard label="Open incidents" value={exec.openIncidents} tone={exec.openIncidents ? "danger" : "success"} icon={<AlertTriangle className="h-4 w-4" />} />
          </div>
          <Card>
            <CardHeader className="py-3"><CardTitle className="text-sm">Executive operations summary</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-3">
              <p>
                The runtime executed <span className="font-semibold tabular-nums">{exec.totalRuns}</span> workflow runs in the last 7 days at a{" "}
                <span className="font-semibold tabular-nums">{Math.round(exec.successRate * 100)}%</span> success rate. Reliability is{" "}
                <span className="font-semibold">{exec.trend}</span> versus the prior 24 hours.
              </p>
              <p>
                <span className="font-semibold tabular-nums">{exec.workflowsHealthy}</span> of <span className="tabular-nums">{exec.automationCoverage}</span> active workflows are at or above an 80 reliability score.{" "}
                <span className={exec.workflowsAtRisk ? "text-warning" : "text-success"}>{exec.workflowsAtRisk}</span> workflows are operating below 60 and require attention.
              </p>
              <p>
                Connector ecosystem averages a <span className="font-semibold tabular-nums">{Math.round(exec.connectorHealthAvg)}</span> reliability score across{" "}
                <span className="tabular-nums">{connectorAnalysis.length}</span> connectors. <span className={exec.openIncidents ? "text-danger" : "text-success"}>{exec.openIncidents}</span> circuit breaker(s) are currently open.
              </p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t border-border">
                {exec.trend === "improving" && <><ArrowUpRight className="h-3.5 w-3.5 text-success" />Outcomes improving — recent fixes appear effective.</>}
                {exec.trend === "degrading" && <><ArrowDownRight className="h-3.5 w-3.5 text-danger" />Outcomes degrading — investigate recently failing workflows in the Execution tab.</>}
                {exec.trend === "stable" && <><Activity className="h-3.5 w-3.5" />Outcomes stable — continue routine monitoring.</>}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {loading && !loaded && <div className="text-xs text-muted-foreground text-center py-4">Loading runtime telemetry…</div>}
    </div>
  );
}

function KnowledgeEditor({ definitions, knowledge, onSave }: {
  definitions: { id: string; name: string; tenant_id: string }[];
  knowledge: KnowledgeEntry[];
  onSave: (k: { definition_id: string; tenant_id: string; purpose: string; owner: string; business_outcome: string; known_risks: string; operational_notes: string }) => Promise<void>;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const def = definitions.find((d) => d.id === sel);
  const k = knowledge.find((k) => k.definition_id === sel);
  const [form, setForm] = useState<{ purpose: string; owner: string; business_outcome: string; known_risks: string; operational_notes: string }>({
    purpose: "", owner: "", business_outcome: "", known_risks: "", operational_notes: "",
  });
  useEffect(() => {
    setForm({
      purpose: k?.purpose ?? "",
      owner: k?.owner ?? "",
      business_outcome: k?.business_outcome ?? "",
      known_risks: k?.known_risks ?? "",
      operational_notes: k?.operational_notes ?? "",
    });
  }, [sel, k]);

  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-4">
        <CardHeader className="py-3"><CardTitle className="text-xs uppercase tracking-wide">Workflows</CardTitle></CardHeader>
        <CardContent>
          <ScrollArea className="h-[500px]">
            {definitions.map((d) => {
              const has = knowledge.find((k) => k.definition_id === d.id);
              return (
                <button key={d.id} onClick={() => setSel(d.id)} className={`w-full text-left px-2 py-2 rounded text-xs mb-1 ${sel === d.id ? "bg-accent" : "hover:bg-accent/50"}`}>
                  <div className="font-medium truncate">{d.name}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{has ? "Documented" : "No notes yet"}</div>
                </button>
              );
            })}
            {definitions.length === 0 && <div className="text-xs text-muted-foreground py-4">No workflows.</div>}
          </ScrollArea>
        </CardContent>
      </Card>
      <Card className="col-span-8">
        <CardHeader className="py-3"><CardTitle className="text-sm">{def ? `Operational knowledge — ${def.name}` : "Select a workflow"}</CardTitle></CardHeader>
        <CardContent>
          {def ? (
            <div className="space-y-3">
              <div><Label className="text-xs">Purpose</Label><Textarea value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} rows={2} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs">Owner</Label><Input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="team or person" /></div>
                <div><Label className="text-xs">Business outcome</Label><Input value={form.business_outcome} onChange={(e) => setForm({ ...form, business_outcome: e.target.value })} placeholder="e.g. customer onboarding" /></div>
              </div>
              <div><Label className="text-xs">Known risks</Label><Textarea value={form.known_risks} onChange={(e) => setForm({ ...form, known_risks: e.target.value })} rows={2} /></div>
              <div><Label className="text-xs">Operational notes</Label><Textarea value={form.operational_notes} onChange={(e) => setForm({ ...form, operational_notes: e.target.value })} rows={3} /></div>
              <div className="flex justify-end"><Button size="sm" onClick={() => onSave({ definition_id: def.id, tenant_id: def.tenant_id, ...form })}>Save knowledge</Button></div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground py-12 text-center">Select a workflow to document its purpose, owner, business outcome, and risks.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
