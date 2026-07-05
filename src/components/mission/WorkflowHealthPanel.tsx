import { useMemo } from "react";
import { useWorkflowStudio, type WfGraph } from "@/store/useWorkflowStudio";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, AlertTriangle, CheckCircle2, GitMerge, Plug, ShieldAlert } from "lucide-react";

type Finding = { level: "ok" | "warn" | "error"; code: string; message: string };
type CountKey = "connector" | "approval" | "rollback" | "parallel" | "branch";
type CountMap = Record<CountKey, number>;

function getConfigValue(config: WfGraph["nodes"][number]["config"], key: string) {
  return typeof config?.[key] === "string" ? config[key] : undefined;
}

function hasConfigArray(config: WfGraph["nodes"][number]["config"], key: string) {
  return Array.isArray(config?.[key]) && config[key].length > 0;
}

function analyze(graph: WfGraph, knownConnectors: Set<string>): { score: number; findings: Finding[] } {
  const findings: Finding[] = [];
  if (!graph || !graph.nodes?.length) {
    return { score: 0, findings: [{ level: "error", code: "empty", message: "Graph has no nodes." }] };
  }
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const n of graph.nodes) { inbound.set(n.id, 0); outbound.set(n.id, 0); }
  for (const e of graph.edges ?? []) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) {
      findings.push({ level: "error", code: "edge_dangling", message: `Edge ${e.from} → ${e.to} references missing node.` });
      continue;
    }
    outbound.set(e.from, (outbound.get(e.from) ?? 0) + 1);
    inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
  }

  // Orphans (no in and no out, except start/end)
  for (const n of graph.nodes) {
    if (n.type === "start" || n.type === "end") continue;
    if ((inbound.get(n.id) ?? 0) === 0 && (outbound.get(n.id) ?? 0) === 0) {
      findings.push({ level: "warn", code: "orphan", message: `Node "${n.label || n.id}" is disconnected.` });
    } else if ((inbound.get(n.id) ?? 0) === 0) {
      findings.push({ level: "warn", code: "unreachable", message: `Node "${n.label || n.id}" is unreachable (no inbound edge).` });
    }
  }

  // Cycle detection (DFS)
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of graph.edges ?? []) if (nodeIds.has(e.from) && nodeIds.has(e.to)) adj.get(e.from)!.push(e.to);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);
  let hasCycle = false;
  function dfs(u: string) {
    color.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) { hasCycle = true; return; }
      if (color.get(v) === WHITE) { dfs(v); if (hasCycle) return; }
    }
    color.set(u, BLACK);
  }
  for (const id of nodeIds) { if (color.get(id) === WHITE) dfs(id); if (hasCycle) break; }
  if (hasCycle) findings.push({ level: "error", code: "cycle", message: "Graph contains a circular dependency." });

  // Missing connector / config
  for (const n of graph.nodes) {
    if (n.type === "connector") {
      const conn = getConfigValue(n.config, "connector") ?? getConfigValue(n.config, "adapter");
      if (!conn) findings.push({ level: "error", code: "no_connector", message: `Connector node "${n.label || n.id}" has no adapter selected.` });
      else if (knownConnectors.size && !knownConnectors.has(conn)) {
        findings.push({ level: "warn", code: "unknown_connector", message: `Adapter "${conn}" not in registered schemas.` });
      }
      if (!(n.retry?.max ?? 0)) findings.push({ level: "warn", code: "no_retry", message: `Node "${n.label || n.id}" has no retry policy.` });
    }
    if (n.type === "approval" && !hasConfigArray(n.config, "approvers")) {
      findings.push({ level: "warn", code: "no_approvers", message: `Approval gate "${n.label || n.id}" has no approver group.` });
    }
  }

  // Score: 100 - 25*error - 6*warn (floored at 0)
  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  const score = Math.max(0, 100 - errs * 25 - warns * 6);
  if (!findings.length) findings.push({ level: "ok", code: "clean", message: "No structural issues detected." });
  return { score, findings };
}

function scoreTone(score: number) {
  if (score >= 85) return { label: "Healthy", cls: "text-success border-success/40 bg-success/10" };
  if (score >= 60) return { label: "Degraded", cls: "text-warning border-warning/40 bg-warning/10" };
  return { label: "At risk", cls: "text-destructive border-destructive/40 bg-destructive/10" };
}

export function WorkflowHealthPanel() {
  const draftGraph = useWorkflowStudio((s) => s.draftGraph);
  const schemas = useWorkflowStudio((s) => s.schemas);
  const selectedVersionId = useWorkflowStudio((s) => s.selectedVersionId);
  const versions = useWorkflowStudio((s) => s.versions);

  const knownConnectors = useMemo(() => new Set(schemas.map((s) => s.connector)), [schemas]);
  const analysis = useMemo(
    () => analyze(draftGraph ?? { nodes: [], edges: [] }, knownConnectors),
    [draftGraph, knownConnectors]
  );
  const version = versions.find((v) => v.id === selectedVersionId);
  const tone = scoreTone(analysis.score);

  const counts = useMemo(() => {
    const c: CountMap = { connector: 0, approval: 0, rollback: 0, parallel: 0, branch: 0 };
    for (const n of draftGraph?.nodes ?? []) {
      if (n.type in c) c[n.type as CountKey]++;
    }
    return c;
  }, [draftGraph]);

  return (
    <Card>
      <CardHeader className="py-3 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-xs uppercase tracking-wide flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5" /> Pre-publish health
        </CardTitle>
        <div className={`px-2 py-1 rounded border font-mono text-[10px] uppercase tracking-wider ${tone.cls}`}>
          {tone.label} · {analysis.score}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-5 gap-2 text-center">
          {[
            { k: "connector", icon: Plug, label: "Connectors" },
            { k: "approval", icon: ShieldAlert, label: "Approvals" },
            { k: "rollback", icon: GitMerge, label: "Rollback" },
            { k: "parallel", icon: Activity, label: "Parallel" },
            { k: "branch", icon: GitMerge, label: "Branch" },
          ].map(({ k, icon: Icon, label }: { k: CountKey; icon: typeof Plug; label: string }) => (
            <div key={k} className="rounded border border-border bg-muted/30 py-2">
              <Icon className="h-3 w-3 mx-auto text-muted-foreground" />
              <div className="font-mono text-sm tabular-nums mt-1">{counts[k]}</div>
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        <div className="rounded border border-border/60 divide-y divide-border/40 max-h-[180px] overflow-auto">
          {analysis.findings.map((f, i) => (
            <div key={i} className="flex items-start gap-2 px-2.5 py-1.5 text-[11px]">
              {f.level === "error" ? <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                : f.level === "warn" ? <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
                : <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />}
              <div className="min-w-0">
                <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground mr-1.5">{f.code}</span>
                <span className="text-foreground/90">{f.message}</span>
              </div>
            </div>
          ))}
        </div>

        {version && (
          <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
            <span>v{version.version} · {version.state}</span>
            <Badge variant="outline" className="text-[9px]">
              {(draftGraph?.nodes?.length ?? 0)} nodes · {(draftGraph?.edges?.length ?? 0)} edges
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
