export interface ReplayCheckpoint {
  step_index: number;
}

export interface ReplayStep {
  name: string;
  connector: string;
  duration_ms?: number | null;
}

export interface ReplaySourceRun {
  workflow_name: string;
  workflow_id?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface ReplayRunInsert {
  workflow_name: string;
  workflow_id?: string | null;
  state: "replaying";
  status: "replaying";
  correlation_id: string;
  payload: Record<string, unknown>;
  started_at: string;
}

export interface ReplayPersistence {
  emit(args: {
    run_id: string;
    step_id?: string | null;
    type: string;
    severity: string;
    message: string;
    data: Record<string, unknown>;
  }): Promise<void>;
  insertStepRun(args: {
    run_id: string;
    step_index: number;
    name: string;
    connector: string;
    state: "running";
    started_at: string;
  }): Promise<{ id: string | null }>;
  updateStepRun(id: string, args: Record<string, unknown>): Promise<void>;
  insertCheckpoint(args: {
    run_id: string;
    step_index: number;
    snapshot: Record<string, unknown>;
  }): Promise<void>;
  updateRun(run_id: string, args: Record<string, unknown>): Promise<void>;
}

export function computeReplayResumeIndex(checkpoints: ReplayCheckpoint[]): number {
  const lastCheckpoint = checkpoints.slice(-1)[0];
  return lastCheckpoint ? lastCheckpoint.step_index + 1 : 0;
}

export function buildReplayRunInsert(args: {
  source: ReplaySourceRun;
  sourceRunId: string;
  correlationId: string;
  resumeIndex: number;
  startedAt?: string;
}): ReplayRunInsert {
  return {
    workflow_name: `${args.source.workflow_name} · replay`,
    workflow_id: args.source.workflow_id,
    state: "replaying",
    status: "replaying",
    correlation_id: args.correlationId,
    payload: {
      ...(args.source.payload ?? {}),
      replay_of: args.sourceRunId,
      resume_from: args.resumeIndex,
    },
    started_at: args.startedAt ?? new Date().toISOString(),
  };
}

export async function runReplaySequence(args: {
  runId: string;
  sourceRunId: string;
  steps: ReplayStep[];
  resumeIndex: number;
  persistence: ReplayPersistence;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}): Promise<{ failed: boolean; durationMs: number }> {
  const random = args.random ?? Math.random;
  const sleep = args.sleep ?? (async () => undefined);
  const now = args.now ?? (() => new Date());
  const startedAt = now().getTime();
  let failed = false;

  for (let index = 0; index < args.resumeIndex; index++) {
    const step = args.steps[index];
    if (!step) {
      continue;
    }
    await args.persistence.emit({
      run_id: args.runId,
      type: "step.replayed",
      severity: "debug",
      message: `↺ ${step.name} (from checkpoint)`,
      data: { index, connector: step.connector, replay: true, source_run_id: args.sourceRunId },
    });
  }

  for (let index = args.resumeIndex; index < args.steps.length; index++) {
    const step = args.steps[index];
    if (!step) {
      continue;
    }

    const startedIso = now().toISOString();
    const { id } = await args.persistence.insertStepRun({
      run_id: args.runId,
      step_index: index,
      name: step.name,
      connector: step.connector,
      state: "running",
      started_at: startedIso,
    });

    await args.persistence.emit({
      run_id: args.runId,
      step_id: id,
      type: "step.started",
      severity: "info",
      message: `▶ ${step.name} (replay)`,
      data: { connector: step.connector, index, replay: true, source_run_id: args.sourceRunId },
    });

    const jitter = Math.round((step.duration_ms ?? 300) * (0.7 + random() * 0.6));
    await sleep(jitter);

    if (random() < 0.02) {
      if (id) {
        await args.persistence.updateStepRun(id, {
          state: "failed",
          ended_at: now().toISOString(),
          duration_ms: jitter,
          error: "Persistent fault on replay",
        });
      }
      await args.persistence.emit({
        run_id: args.runId,
        step_id: id,
        type: "step.failed",
        severity: "error",
        message: `✗ ${step.name} failed on replay`,
        data: { error: "Persistent fault", replay: true, source_run_id: args.sourceRunId },
      });
      failed = true;
      break;
    }

    if (id) {
      await args.persistence.updateStepRun(id, {
        state: "completed",
        ended_at: now().toISOString(),
        duration_ms: jitter,
        result: { ok: true, replayed: true },
      });
    }

    await args.persistence.insertCheckpoint({
      run_id: args.runId,
      step_index: index,
      snapshot: { step: step.name, ok: true, replayed: true },
    });

    await args.persistence.emit({
      run_id: args.runId,
      step_id: id,
      type: "step.completed",
      severity: "info",
      message: `✓ ${step.name} (${jitter}ms · replay)`,
      data: { duration_ms: jitter, replay: true, source_run_id: args.sourceRunId },
    });
  }

  const durationMs = now().getTime() - startedAt;
  await args.persistence.updateRun(args.runId, {
    state: failed ? "failed" : "completed",
    status: failed ? "failed" : "completed",
    ended_at: now().toISOString(),
    duration_ms: durationMs,
    result: failed ? null : { replayed_of: args.sourceRunId },
    error: failed ? "Persistent fault on replay" : null,
  });

  await args.persistence.emit({
    run_id: args.runId,
    type: failed ? "replay.failed" : "replay.completed",
    severity: failed ? "error" : "info",
    message: failed ? `Replay failed in ${durationMs}ms` : `Replay completed in ${durationMs}ms`,
    data: { duration_ms: durationMs, replay: true, source_run_id: args.sourceRunId },
  });

  return { failed, durationMs };
}
