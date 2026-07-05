import { create } from "zustand";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

type GraphNode = Record<string, Json | undefined>;
type GraphEdge = Record<string, Json | undefined>;

type Run = {
  id: string;
  workflow_id: string | null;
  workflow_name: string;
  state: string;
  status: string;
  duration_ms: number | null;
  retry_count: number;
  started_at: string;
  ended_at: string | null;
  error: string | null;
  tenant_id: string | null;
};

type Step = {
  id: string;
  run_id: string;
  name: string;
  connector: string | null;
  state: string;
  duration_ms: number | null;
  retry_count: number;
  attempt: number;
  started_at: string | null;
  error: string | null;
};

type Definition = {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  latest_version: number;
};

type Version = {
  id: string;
  definition_id: string;
  version: number;
  graph: { nodes?: GraphNode[]; edges?: GraphEdge[] } | null;
  validation: Json;
  state: string;
};

type Knowledge = {
  id: string;
  definition_id: string;
  tenant_id: string;
  purpose: string | null;
  owner: string | null;
  business_outcome: string | null;
  known_risks: string | null;
  operational_notes: string | null;
  updated_at: string;
};

type Anomaly = {
  id: string;
  detected_at: string;
  kind: string;
  severity: string;
  scope: string;
  subject: string | null;
  metric_value: number | null;
  baseline_value: number | null;
  explanation: string;
  evidence: Json;
};

type Breaker = {
  connector: string;
  state: string;
  failure_count: number;
  success_count: number;
  last_failure_at: string | null;
  opened_at: string | null;
};

type Approval = { id: string; run_id: string; state: string; requested_at: string };
type Rollback = { id: string; run_id: string; started_at: string };

interface ReliabilityState {
  loading: boolean;
  loaded: boolean;
  runs: Run[];
  steps: Step[];
  definitions: Definition[];
  versions: Version[];
  knowledge: Knowledge[];
  anomalies: Anomaly[];
  breakers: Breaker[];
  approvals: Approval[];
  rollbacks: Rollback[];
  load: () => Promise<void>;
  saveKnowledge: (input: Omit<Knowledge, "id" | "updated_at">) => Promise<void>;
  recordAnomaly: (a: Omit<Anomaly, "id" | "detected_at">, tenantId: string | null) => Promise<void>;
}

export const useReliability = create<ReliabilityState>((set, get) => ({
  loading: false,
  loaded: false,
  runs: [],
  steps: [],
  definitions: [],
  versions: [],
  knowledge: [],
  anomalies: [],
  breakers: [],
  approvals: [],
  rollbacks: [],

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [runsR, defsR, versR, knR, anR, brR, apR, rbR] = await Promise.all([
      supabase.from("workflow_runs").select("id,workflow_id,workflow_name,state,status,duration_ms,retry_count,started_at,ended_at,error,tenant_id").gte("started_at", since).order("started_at", { ascending: false }).limit(2000),
      supabase.from("workflow_definitions").select("id,tenant_id,key,name,latest_version"),
      supabase.from("workflow_versions").select("id,definition_id,version,graph,validation,state"),
      supabase.from("workflow_knowledge").select("*"),
      supabase.from("runtime_anomalies").select("*").order("detected_at", { ascending: false }).limit(200),
      supabase.from("connector_circuit_breakers").select("connector,state,failure_count,success_count,last_failure_at,opened_at"),
      supabase.from("workflow_approvals").select("id,run_id,state,requested_at").gte("requested_at", since).limit(1000),
      supabase.from("workflow_rollbacks").select("id,run_id,started_at").gte("started_at", since).limit(500),
    ]);

    const runs = (runsR.data ?? []) as Run[];
    const runIds = runs.map((r) => r.id);
    const steps: Step[] = [];
    if (runIds.length) {
      const chunk = 500;
      for (let i = 0; i < runIds.length; i += chunk) {
        const { data } = await supabase
          .from("workflow_step_runs")
          .select("id,run_id,name,connector,state,duration_ms,retry_count,attempt,started_at,error")
          .in("run_id", runIds.slice(i, i + chunk))
          .limit(5000);
        if (data) steps.push(...(data as Step[]));
      }
    }

    set({
      loading: false,
      loaded: true,
      runs: runs as Run[],
      steps: steps as Step[],
      definitions: (defsR.data ?? []) as Definition[],
      versions: (versR.data ?? []) as Version[],
      knowledge: (knR.data ?? []) as Knowledge[],
      anomalies: (anR.data ?? []) as Anomaly[],
      breakers: (brR.data ?? []) as Breaker[],
      approvals: (apR.data ?? []) as Approval[],
      rollbacks: (rbR.data ?? []) as Rollback[],
    });
  },

  saveKnowledge: async (input) => {
    const existing = get().knowledge.find((k) => k.definition_id === input.definition_id);
    if (existing) {
      const { error } = await supabase
        .from("workflow_knowledge")
        .update({
          purpose: input.purpose,
          owner: input.owner,
          business_outcome: input.business_outcome,
          known_risks: input.known_risks,
          operational_notes: input.operational_notes,
        })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("workflow_knowledge").insert({
        definition_id: input.definition_id,
        tenant_id: input.tenant_id,
        purpose: input.purpose,
        owner: input.owner,
        business_outcome: input.business_outcome,
        known_risks: input.known_risks,
        operational_notes: input.operational_notes,
      });
      if (error) throw error;
    }
    const { data } = await supabase.from("workflow_knowledge").select("*");
    set({ knowledge: (data ?? []) as Knowledge[] });
  },

  recordAnomaly: async (a, tenantId) => {
    const { error } = await supabase.from("runtime_anomalies").insert({ ...a, tenant_id: tenantId });
    if (error) throw error;
    const { data } = await supabase.from("runtime_anomalies").select("*").order("detected_at", { ascending: false }).limit(200);
    set({ anomalies: (data ?? []) as Anomaly[] });
  },
}));

// ---- Pure analysis helpers (explainable scoring) ----

export type WorkflowReliability = {
  workflow_id: string | null;
  workflow_name: string;
  runs: number;
  completed: number;
  failed: number;
  retried: number;
  successRate: number;
  retryRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  score: number; // 0-100
  rationale: string[];
};

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function analyzeWorkflows(runs: Run[]): WorkflowReliability[] {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const key = r.workflow_id ?? r.workflow_name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const out: WorkflowReliability[] = [];
  for (const [, list] of groups) {
    const completed = list.filter((r) => r.state === "completed").length;
    const failed = list.filter((r) => r.state === "failed").length;
    const retried = list.filter((r) => (r.retry_count ?? 0) > 0).length;
    const total = completed + failed;
    const successRate = total > 0 ? completed / total : 1;
    const retryRate = list.length ? retried / list.length : 0;
    const durations = list.map((r) => r.duration_ms ?? 0).filter((d) => d > 0).sort((a, b) => a - b);
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const p95 = percentile(durations, 95);

    const rationale: string[] = [];
    let score = 100;
    if (successRate < 1) {
      const drop = Math.round((1 - successRate) * 60);
      score -= drop;
      rationale.push(`${Math.round((1 - successRate) * 100)}% of recent runs failed (-${drop}).`);
    }
    if (retryRate > 0.1) {
      const drop = Math.round(retryRate * 30);
      score -= drop;
      rationale.push(`${Math.round(retryRate * 100)}% of runs required a retry (-${drop}).`);
    }
    if (p95 > 30_000) {
      score -= 10;
      rationale.push(`p95 duration ${Math.round(p95 / 100) / 10}s exceeds 30s budget (-10).`);
    }
    if (list.length < 5) rationale.push(`Sample size is small (${list.length} runs) — score is provisional.`);
    if (rationale.length === 0) rationale.push("All recent runs completed without retries within budget.");

    out.push({
      workflow_id: list[0].workflow_id,
      workflow_name: list[0].workflow_name,
      runs: list.length,
      completed,
      failed,
      retried,
      successRate,
      retryRate,
      avgDurationMs: Math.round(avg),
      p95DurationMs: Math.round(p95),
      score: Math.max(0, Math.min(100, score)),
      rationale,
    });
  }
  return out.sort((a, b) => a.score - b.score);
}

export type StepBehavior = {
  name: string;
  connector: string | null;
  runs: number;
  failures: number;
  retries: number;
  avgDurationMs: number;
  p95DurationMs: number;
  flags: string[];
};

export function analyzeSteps(steps: Step[]): StepBehavior[] {
  const groups = new Map<string, Step[]>();
  for (const s of steps) {
    const key = `${s.name}::${s.connector ?? "—"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const out: StepBehavior[] = [];
  for (const [, list] of groups) {
    const failures = list.filter((s) => s.state === "failed").length;
    const retries = list.reduce((a, s) => a + (s.retry_count ?? 0), 0);
    const durations = list.map((s) => s.duration_ms ?? 0).filter((d) => d > 0).sort((a, b) => a - b);
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const p95 = percentile(durations, 95);

    const flags: string[] = [];
    if (list.length >= 5 && failures / list.length > 0.2) flags.push("unstable");
    if (retries / Math.max(1, list.length) > 0.5) flags.push("excessive-retries");
    if (p95 > 10_000) flags.push("slow");
    if (list.length >= 10 && p95 > avg * 3) flags.push("bottleneck");

    out.push({
      name: list[0].name,
      connector: list[0].connector,
      runs: list.length,
      failures,
      retries,
      avgDurationMs: Math.round(avg),
      p95DurationMs: Math.round(p95),
      flags,
    });
  }
  return out.sort((a, b) => b.failures - a.failures || b.p95DurationMs - a.p95DurationMs);
}

export type ConnectorReliability = {
  connector: string;
  invocations: number;
  failures: number;
  retries: number;
  avgLatencyMs: number;
  breakerState: string;
  breakerOpenedAt: string | null;
  score: number;
  rationale: string[];
};

export function analyzeConnectors(steps: Step[], breakers: Breaker[]): ConnectorReliability[] {
  const groups = new Map<string, Step[]>();
  for (const s of steps) {
    if (!s.connector) continue;
    if (!groups.has(s.connector)) groups.set(s.connector, []);
    groups.get(s.connector)!.push(s);
  }
  const out: ConnectorReliability[] = [];
  const allKeys = new Set<string>([...groups.keys(), ...breakers.map((b) => b.connector)]);
  for (const c of allKeys) {
    const list = groups.get(c) ?? [];
    const breaker = breakers.find((b) => b.connector === c);
    const failures = list.filter((s) => s.state === "failed").length;
    const retries = list.reduce((a, s) => a + (s.retry_count ?? 0), 0);
    const durations = list.map((s) => s.duration_ms ?? 0).filter((d) => d > 0);
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const total = list.length;
    const failRate = total ? failures / total : 0;

    const rationale: string[] = [];
    let score = 100;
    if (failRate > 0) {
      const drop = Math.round(failRate * 55);
      score -= drop;
      rationale.push(`${Math.round(failRate * 100)}% of recent calls failed (-${drop}).`);
    }
    if (retries / Math.max(1, total) > 0.2) {
      score -= 15;
      rationale.push(`Retry pressure ${Math.round((retries / Math.max(1, total)) * 100)}% (-15).`);
    }
    if (avg > 5000) {
      score -= 10;
      rationale.push(`Average latency ${Math.round(avg)}ms above 5s budget (-10).`);
    }
    if (breaker?.state === "open") {
      score -= 30;
      rationale.push("Circuit breaker currently OPEN (-30).");
    } else if (breaker?.state === "half_open") {
      score -= 10;
      rationale.push("Circuit breaker is HALF-OPEN, probing recovery (-10).");
    }
    if (total === 0 && !breaker) rationale.push("No telemetry yet — score is provisional.");
    if (rationale.length === 0) rationale.push("No failures, retries, or breaker activity in the window.");

    out.push({
      connector: c,
      invocations: total,
      failures,
      retries,
      avgLatencyMs: Math.round(avg),
      breakerState: breaker?.state ?? "closed",
      breakerOpenedAt: breaker?.opened_at ?? null,
      score: Math.max(0, Math.min(100, score)),
      rationale,
    });
  }
  return out.sort((a, b) => a.score - b.score);
}

export type Anomalyish = {
  kind: string;
  severity: "warn" | "critical";
  scope: string;
  subject: string;
  explanation: string;
  evidence: Record<string, unknown>;
};

export function detectAnomalies(runs: Run[], steps: Step[], breakers: Breaker[], approvals: Approval[]): Anomalyish[] {
  const out: Anomalyish[] = [];
  const now = Date.now();
  const last1h = runs.filter((r) => now - new Date(r.started_at).getTime() < 60 * 60_000);
  const prev1h = runs.filter((r) => {
    const t = now - new Date(r.started_at).getTime();
    return t >= 60 * 60_000 && t < 2 * 60 * 60_000;
  });

  const failNow = last1h.filter((r) => r.state === "failed").length;
  const failPrev = prev1h.filter((r) => r.state === "failed").length;
  if (failNow >= 3 && failNow >= failPrev * 2 + 1) {
    out.push({
      kind: "failure_spike",
      severity: failNow >= 10 ? "critical" : "warn",
      scope: "global",
      subject: "workflow_runs",
      explanation: `Failures in the last hour (${failNow}) are at least 2x the prior hour (${failPrev}). Indicates emerging instability.`,
      evidence: { failNow, failPrev },
    });
  }

  // Slowdown
  const durNow = last1h.map((r) => r.duration_ms ?? 0).filter((d) => d > 0);
  const durPrev = prev1h.map((r) => r.duration_ms ?? 0).filter((d) => d > 0);
  const avgNow = durNow.length ? durNow.reduce((a, b) => a + b, 0) / durNow.length : 0;
  const avgPrev = durPrev.length ? durPrev.reduce((a, b) => a + b, 0) / durPrev.length : 0;
  if (avgPrev > 0 && avgNow > avgPrev * 1.75 && durNow.length >= 5) {
    out.push({
      kind: "execution_slowdown",
      severity: "warn",
      scope: "global",
      subject: "workflow_runs",
      explanation: `Average run duration jumped from ${Math.round(avgPrev)}ms to ${Math.round(avgNow)}ms (>75% slower).`,
      evidence: { avgNow: Math.round(avgNow), avgPrev: Math.round(avgPrev) },
    });
  }

  // Retry explosion per step name
  const stepGroups = new Map<string, Step[]>();
  for (const s of steps) {
    if (!s.started_at) continue;
    if (now - new Date(s.started_at).getTime() > 60 * 60_000) continue;
    const k = s.name;
    if (!stepGroups.has(k)) stepGroups.set(k, []);
    stepGroups.get(k)!.push(s);
  }
  for (const [name, list] of stepGroups) {
    const totalRetries = list.reduce((a, s) => a + (s.retry_count ?? 0), 0);
    if (list.length >= 5 && totalRetries / list.length > 1.5) {
      out.push({
        kind: "retry_explosion",
        severity: "warn",
        scope: "step",
        subject: name,
        explanation: `Step "${name}" averaged ${(totalRetries / list.length).toFixed(1)} retries per execution in the last hour.`,
        evidence: { totalRetries, executions: list.length },
      });
    }
  }

  // Connector instability via breakers
  for (const b of breakers) {
    if (b.state === "open") {
      out.push({
        kind: "connector_instability",
        severity: "critical",
        scope: "connector",
        subject: b.connector,
        explanation: `Connector "${b.connector}" circuit breaker is OPEN after ${b.failure_count} failures. Calls are short-circuited.`,
        evidence: { failure_count: b.failure_count, opened_at: b.opened_at },
      });
    }
  }

  // Approval surge
  const apNow = approvals.filter((a) => now - new Date(a.requested_at).getTime() < 60 * 60_000).length;
  const apPrev = approvals.filter((a) => {
    const t = now - new Date(a.requested_at).getTime();
    return t >= 60 * 60_000 && t < 2 * 60 * 60_000;
  }).length;
  if (apNow >= 5 && apNow >= apPrev * 2 + 1) {
    out.push({
      kind: "approval_surge",
      severity: "warn",
      scope: "global",
      subject: "approvals",
      explanation: `Approval requests in the last hour (${apNow}) are 2x+ the prior hour (${apPrev}). Operators may be a bottleneck.`,
      evidence: { apNow, apPrev },
    });
  }

  return out;
}

export type DependencyMap = {
  definition_id: string;
  workflow_name: string;
  connectors: string[];
  secrets: string[];
  risk: "low" | "medium" | "high";
  rationale: string[];
};

export function mapDependencies(
  definitions: Definition[],
  versions: Version[],
  breakers: Breaker[],
  connectorReliability: ConnectorReliability[],
): DependencyMap[] {
  return definitions.map((d) => {
    const v = versions.find((v) => v.definition_id === d.id && v.version === d.latest_version);
    const nodes = v?.graph?.nodes ?? [];
    const connectors = Array.from(new Set(nodes.map((n) => n.connector).filter(Boolean)));
    const secrets = Array.from(new Set(nodes.flatMap((n) => n.secrets ?? []).filter(Boolean))) as string[];

    const rationale: string[] = [];
    let risk: "low" | "medium" | "high" = "low";

    const openBreakers = connectors.filter((c) => breakers.find((b) => b.connector === c && b.state !== "closed"));
    if (openBreakers.length) {
      risk = "high";
      rationale.push(`Depends on ${openBreakers.length} connector(s) with active circuit breaker: ${openBreakers.join(", ")}.`);
    }
    const weak = connectors.filter((c) => {
      const rel = connectorReliability.find((r) => r.connector === c);
      return rel && rel.score < 70;
    });
    if (weak.length && risk !== "high") {
      risk = "medium";
      rationale.push(`Uses connector(s) below 70 reliability score: ${weak.join(", ")}.`);
    }
    if (connectors.length >= 5 && risk === "low") {
      risk = "medium";
      rationale.push(`Depends on ${connectors.length} connectors — high coupling surface.`);
    }
    if (rationale.length === 0) rationale.push("All dependencies are healthy and breaker state is closed.");

    return {
      definition_id: d.id,
      workflow_name: d.name,
      connectors,
      secrets,
      risk,
      rationale,
    };
  });
}

export type ReadinessReview = {
  definition_id: string;
  workflow_name: string;
  verdict: "PASS" | "WARNING" | "FAIL";
  findings: { level: "error" | "warning" | "info"; message: string; reason: string }[];
};

export function reviewReadiness(
  definitions: Definition[],
  versions: Version[],
  dependencies: DependencyMap[],
  knowledge: Knowledge[],
): ReadinessReview[] {
  return definitions.map((d) => {
    const v = versions.find((x) => x.definition_id === d.id && x.version === d.latest_version);
    const findings: ReadinessReview["findings"] = [];
    const nodes = v?.graph?.nodes ?? [];
    const edges = v?.graph?.edges ?? [];

    // Cycle detection
    const adj = new Map<string, string[]>();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) adj.get(e.from)?.push(e.to);
    const colors = new Map<string, number>();
    const dfs = (id: string): boolean => {
      colors.set(id, 1);
      for (const n of adj.get(id) ?? []) {
        const c = colors.get(n) ?? 0;
        if (c === 1) return true;
        if (c === 0 && dfs(n)) return true;
      }
      colors.set(id, 2);
      return false;
    };
    let hasCycle = false;
    for (const n of nodes) if ((colors.get(n.id) ?? 0) === 0 && dfs(n.id)) { hasCycle = true; break; }
    if (hasCycle) findings.push({ level: "error", message: "Graph contains a cycle.", reason: "Cycles cause infinite execution loops and prevent topological scheduling." });

    // Orphan nodes
    const referenced = new Set<string>();
    for (const e of edges) { referenced.add(e.from); referenced.add(e.to); }
    const orphans = nodes.filter((n) => !referenced.has(n.id) && nodes.length > 1);
    if (orphans.length) findings.push({ level: "warning", message: `${orphans.length} orphan node(s).`, reason: "Disconnected nodes never execute and signal incomplete authoring." });

    // Missing connector config
    const missingConn = nodes.filter((n) => n.kind === "connector" && !n.connector);
    if (missingConn.length) findings.push({ level: "error", message: `${missingConn.length} step(s) missing connector binding.`, reason: "Steps without a connector will fail at dispatch time." });

    // Dependency risk
    const dep = dependencies.find((x) => x.definition_id === d.id);
    if (dep?.risk === "high") findings.push({ level: "error", message: "High dependency risk.", reason: dep.rationale.join(" ") });
    else if (dep?.risk === "medium") findings.push({ level: "warning", message: "Medium dependency risk.", reason: dep?.rationale.join(" ") ?? "" });

    // Governance / knowledge gap
    const k = knowledge.find((k) => k.definition_id === d.id);
    if (!k || !k.owner) findings.push({ level: "warning", message: "No operational owner recorded.", reason: "Workflows without an owner have no clear escalation path during incidents." });
    if (!k?.business_outcome) findings.push({ level: "info", message: "Business outcome not documented.", reason: "Helps stakeholders understand the value of this workflow." });

    let verdict: "PASS" | "WARNING" | "FAIL" = "PASS";
    if (findings.some((f) => f.level === "error")) verdict = "FAIL";
    else if (findings.some((f) => f.level === "warning")) verdict = "WARNING";

    return { definition_id: d.id, workflow_name: d.name, verdict, findings };
  });
}

export type ExecutiveSummary = {
  totalRuns: number;
  successRate: number;
  workflowsHealthy: number;
  workflowsAtRisk: number;
  automationCoverage: number;
  connectorHealthAvg: number;
  openIncidents: number;
  trend: "improving" | "stable" | "degrading";
};

export function executiveSummary(
  runs: Run[],
  workflowAnalysis: WorkflowReliability[],
  connectorAnalysis: ConnectorReliability[],
  breakers: Breaker[],
): ExecutiveSummary {
  const completed = runs.filter((r) => r.state === "completed").length;
  const failed = runs.filter((r) => r.state === "failed").length;
  const total = completed + failed;
  const successRate = total ? completed / total : 1;
  const healthy = workflowAnalysis.filter((w) => w.score >= 80).length;
  const atRisk = workflowAnalysis.filter((w) => w.score < 60).length;
  const connectorHealthAvg = connectorAnalysis.length
    ? connectorAnalysis.reduce((a, c) => a + c.score, 0) / connectorAnalysis.length
    : 100;
  const openIncidents = breakers.filter((b) => b.state === "open").length;

  // Trend: compare last 24h vs prior 24h success rate
  const now = Date.now();
  const last24 = runs.filter((r) => now - new Date(r.started_at).getTime() < 24 * 3600_000);
  const prev24 = runs.filter((r) => {
    const t = now - new Date(r.started_at).getTime();
    return t >= 24 * 3600_000 && t < 48 * 3600_000;
  });
  const sr = (rs: Run[]) => {
    const c = rs.filter((r) => r.state === "completed").length;
    const f = rs.filter((r) => r.state === "failed").length;
    return c + f > 0 ? c / (c + f) : null;
  };
  const srNow = sr(last24);
  const srPrev = sr(prev24);
  let trend: ExecutiveSummary["trend"] = "stable";
  if (srNow != null && srPrev != null) {
    if (srNow > srPrev + 0.05) trend = "improving";
    else if (srNow < srPrev - 0.05) trend = "degrading";
  }

  return {
    totalRuns: runs.length,
    successRate,
    workflowsHealthy: healthy,
    workflowsAtRisk: atRisk,
    automationCoverage: workflowAnalysis.length,
    connectorHealthAvg,
    openIncidents,
    trend,
  };
}
