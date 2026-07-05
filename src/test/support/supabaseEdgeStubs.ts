import type { ReplayPersistence } from "../../../supabase/functions/replay-workflow/logic.ts";
import type { RuntimeValidationGateway } from "../../../supabase/functions/runtime-validate/logic.ts";

export function createRuntimeValidationGateway(overrides: Partial<RuntimeValidationGateway> = {}): RuntimeValidationGateway {
  return {
    listOrphanedRuns: async () => [],
    listStaleLeases: async () => [],
    listOfflineWorkerCounters: async () => [],
    listStaleHeartbeats: async () => [],
    listRecentDeadLetters: async () => [],
    listRecentCompletedRuns: async () => [],
    listCheckpointsForRuns: async () => [],
    listOpenBreaches: async () => [],
    listSlaIncidents: async () => [],
    listQueuePressureJobs: async () => [],
    countActiveRuns: async () => 0,
    countRecentEvents: async () => 0,
    listExpiredApprovals: async () => [],
    ...overrides,
  };
}

export function createReplayPersistenceRecorder() {
  const events: Array<Record<string, unknown>> = [];
  const stepUpdates: Array<{ id: string; args: Record<string, unknown> }> = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const runUpdates: Array<{ run_id: string; args: Record<string, unknown> }> = [];
  let stepCounter = 0;

  const persistence: ReplayPersistence = {
    async emit(args) {
      events.push(args);
    },
    async insertStepRun(args) {
      stepCounter += 1;
      events.push({ type: "step.inserted", ...args });
      return { id: `step-${stepCounter}` };
    },
    async updateStepRun(id, args) {
      stepUpdates.push({ id, args });
    },
    async insertCheckpoint(args) {
      checkpoints.push(args);
    },
    async updateRun(run_id, args) {
      runUpdates.push({ run_id, args });
    },
  };

  return { persistence, events, stepUpdates, checkpoints, runUpdates };
}
