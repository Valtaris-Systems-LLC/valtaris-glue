import { describe, expect, it } from "vitest";
import { buildReplayRunInsert, computeReplayResumeIndex, runReplaySequence } from "../../../supabase/functions/replay-workflow/logic.ts";
import { replaySteps } from "../fixtures/runtimeWorkflows";
import { createReplayPersistenceRecorder } from "../support/supabaseEdgeStubs";

describe("replay and checkpoint logic", () => {
  it("computes the replay resume index from the latest checkpoint", () => {
    expect(computeReplayResumeIndex([{ step_index: 0 }, { step_index: 1 }])).toBe(2);
    expect(computeReplayResumeIndex([])).toBe(0);
  });

  it("builds a replay run payload that tracks the source run and resume point", () => {
    const replayRun = buildReplayRunInsert({
      source: {
        workflow_name: "Order workflow",
        workflow_id: "wf-1",
        dag_id: "orders",
        tenant_id: "tenant-1",
        workflow_version_id: "wv-7",
        payload: { order_id: "ord-1" },
      },
      sourceRunId: "run-source",
      correlationId: "corr-replay",
      resumeIndex: 2,
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(replayRun.payload).toMatchObject({
      order_id: "ord-1",
      replay_of: "run-source",
      resume_from: 2,
    });
    expect(replayRun).toMatchObject({
      dag_id: "orders",
      tenant_id: "tenant-1",
      workflow_version_id: "wv-7",
    });
    expect(replayRun.state).toBe("replaying");
  });

  it("replays checkpointed steps and checkpoints resumed steps", async () => {
    const recorder = createReplayPersistenceRecorder();
    let clock = 0;

    const result = await runReplaySequence({
      runId: "run-replay",
      sourceRunId: "run-source",
      steps: replaySteps,
      resumeIndex: 1,
      persistence: recorder.persistence,
      random: () => 0.5,
      sleep: async () => undefined,
      now: () => new Date(clock += 1000),
    });

    expect(result.failed).toBe(false);
    expect(recorder.events.some((event) => event.type === "step.replayed")).toBe(true);
    expect(recorder.checkpoints).toHaveLength(2);
    expect(recorder.runUpdates.at(-1)?.args).toMatchObject({ state: "completed", status: "completed" });
  });
});
