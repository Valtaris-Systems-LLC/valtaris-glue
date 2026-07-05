export type Severity = "info" | "warn" | "error";

export interface Check {
  id: string;
  severity: Severity;
  ok: boolean;
  count: number;
  sample?: unknown;
  message: string;
}

export interface RuntimeValidationReport {
  checks: Check[];
  summary: Record<Severity, number> & { ok: number };
}

export interface RuntimeValidationGateway {
  listOrphanedRuns(olderThanIso: string): Promise<unknown[]>;
  listStaleLeases(nowIso: string): Promise<unknown[]>;
  listOfflineWorkerCounters(): Promise<unknown[]>;
  listStaleHeartbeats(olderThanIso: string): Promise<unknown[]>;
  listRecentDeadLetters(sinceIso: string): Promise<unknown[]>;
  listRecentCompletedRuns(sinceIso: string): Promise<Array<{ id: string; workflow_name?: string }>>;
  listCheckpointsForRuns(runIds: string[]): Promise<Array<{ run_id: string }>>;
  listOpenBreaches(): Promise<Array<{ run_id?: string | null } & Record<string, unknown>>>;
  listSlaIncidents(runIds: string[]): Promise<Array<{ run_id: string }>>;
  listQueuePressureJobs(olderThanIso: string): Promise<unknown[]>;
  countActiveRuns(): Promise<number>;
  countRecentEvents(sinceIso: string): Promise<number>;
  listExpiredApprovals(nowIso: string): Promise<unknown[]>;
}

export async function buildRuntimeValidationReport(
  gateway: RuntimeValidationGateway,
  now = new Date(),
): Promise<RuntimeValidationReport> {
  const checks: Check[] = [];

  const push = async (
    id: string,
    severity: Severity,
    message: string,
    query: () => Promise<{ count: number; sample?: unknown }>,
  ) => {
    try {
      const { count, sample } = await query();
      checks.push({ id, severity, ok: count === 0, count, sample, message });
    } catch (error) {
      checks.push({
        id,
        severity: "error",
        ok: false,
        count: -1,
        message: `check failed: ${(error as Error).message}`,
      });
    }
  };

  await push(
    "orphaned_runs",
    "error",
    "Runs marked running for >1h with no step activity in the last 10 min",
    async () => {
      const rows = await gateway.listOrphanedRuns(new Date(now.getTime() - 60 * 60 * 1000).toISOString());
      return { count: rows.length, sample: rows[0] };
    },
  );

  await push(
    "stale_leases",
    "warn",
    "Jobs in claimed/running with lease_expires_at in the past",
    async () => {
      const rows = await gateway.listStaleLeases(now.toISOString());
      return { count: rows.length, sample: rows[0] };
    },
  );

  await push(
    "offline_worker_counters",
    "warn",
    "Workers marked offline still report active_jobs > 0",
    async () => {
      const rows = await gateway.listOfflineWorkerCounters();
      return { count: rows.length, sample: rows[0] };
    },
  );

  await push(
    "stale_heartbeats",
    "warn",
    "Workers in 'active' state with no heartbeat in last 3 min",
    async () => {
      const rows = await gateway.listStaleHeartbeats(new Date(now.getTime() - 3 * 60 * 1000).toISOString());
      return { count: rows.length, sample: rows[0] };
    },
  );

  await push(
    "dead_letter_growth",
    "warn",
    "Dead-letter items added in the last hour",
    async () => {
      const rows = await gateway.listRecentDeadLetters(new Date(now.getTime() - 60 * 60 * 1000).toISOString());
      return { count: rows.length, sample: rows[0] };
    },
  );

  await push(
    "runs_without_checkpoints",
    "error",
    "Completed runs with zero checkpoint rows — not replayable",
    async () => {
      const runs = await gateway.listRecentCompletedRuns(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
      if (runs.length === 0) {
        return { count: 0 };
      }
      const checkpoints = await gateway.listCheckpointsForRuns(runs.map((run) => run.id));
      const seen = new Set(checkpoints.map((checkpoint) => checkpoint.run_id));
      const missing = runs.filter((run) => !seen.has(run.id));
      return { count: missing.length, sample: missing[0] };
    },
  );

  await push(
    "breach_without_incident",
    "warn",
    "SLA breaches open without an incident record",
    async () => {
      const breaches = await gateway.listOpenBreaches();
      if (breaches.length === 0) {
        return { count: 0 };
      }
      const runIds = [...new Set(breaches.map((breach) => breach.run_id).filter(Boolean))] as string[];
      if (runIds.length === 0) {
        return { count: breaches.length, sample: breaches[0] };
      }
      const incidents = await gateway.listSlaIncidents(runIds);
      const seen = new Set(incidents.map((incident) => incident.run_id));
      const missing = breaches.filter((breach) => breach.run_id && !seen.has(breach.run_id));
      return { count: missing.length, sample: missing[0] };
    },
  );

  await push(
    "queue_pressure",
    "warn",
    "Jobs waiting >5 min in queued/retrying — possible worker shortage",
    async () => {
      const rows = await gateway.listQueuePressureJobs(new Date(now.getTime() - 5 * 60 * 1000).toISOString());
      return { count: rows.length, sample: rows[0] };
    },
  );

  await push(
    "telemetry_gap",
    "warn",
    "No workflow_events in the last 5 min while runs are still active",
    async () => {
      const running = await gateway.countActiveRuns();
      if (running === 0) {
        return { count: 0 };
      }
      const recent = await gateway.countRecentEvents(new Date(now.getTime() - 5 * 60 * 1000).toISOString());
      return { count: recent === 0 ? running : 0 };
    },
  );

  await push(
    "expired_approvals_not_swept",
    "warn",
    "Approvals pending past expires_at not yet swept",
    async () => {
      const rows = await gateway.listExpiredApprovals(now.toISOString());
      return { count: rows.length, sample: rows[0] };
    },
  );

  const summary = checks.reduce(
    (acc, check) => {
      if (check.ok) {
        acc.ok += 1;
      } else {
        acc[check.severity] += 1;
      }
      return acc;
    },
    { ok: 0, info: 0, warn: 0, error: 0 } as Record<Severity, number> & { ok: number },
  );

  return { checks, summary };
}
