// src/orchestration/workflow-runner.ts
// Valtaris Glue — Workflow Runner
//
// Coordinates workflow execution:
// - loads workflow definition
// - routes steps
// - dispatches jobs
// - updates workflow progress
// - emits events
// - interacts with runtime engine

import { EventEmitter } from "../runtime/event-emitter";
import { WorkflowProgress } from "../runtime/workflow-progress";
import { JobClaim } from "../runtime/job-claim";
import { deepMerge } from "../runtime/utils/deep-merge";

export interface WorkflowDefinition {
  id: string;
  steps: Record<
    string,
    {
      type: "task" | "branch" | "end";
      next?: string;
      branches?: Record<string, string>;
    }
  >;
}

export class WorkflowRunner {
  private events = new EventEmitter();
  private progress = new WorkflowProgress();

  constructor(private definition: WorkflowDefinition) {}

  async start(runId: string, initialPayload: Record<string, unknown>) {
    this.events.workflowStarted(runId, this.definition.id);

    const firstStep = Object.keys(this.definition.steps)[0];
    return this.executeStep(runId, firstStep, initialPayload);
  }

  private async executeStep(
    runId: string,
    stepId: string,
    payload: Record<string, unknown>
  ) {
    const step = this.definition.steps[stepId];

    if (!step) {
      throw new Error(`workflow.step_missing: '${stepId}' not found`);
    }

    if (step.type === "end") {
      this.events.workflowCompleted(runId);
      return payload;
    }

    if (step.type === "task") {
      const jobId = crypto.randomUUID();

      this.events.jobQueued(runId, jobId, stepId);

      const claim = new JobClaim();
      const workerId = claim.claim(jobId);

      this.events.jobClaimed(runId, jobId, stepId, workerId);
      this.events.jobStarted(runId, jobId, stepId);

      const output = await this.runTask(stepId, payload);

      this.events.jobCompleted(runId, jobId, stepId, output);

      const merged = deepMerge(payload, output);

      this.progress.update(runId, stepId, merged);

      return this.executeStep(runId, step.next!, merged);
    }

    if (step.type === "branch") {
      const branchKey = await this.evaluateBranch(stepId, payload);
      const nextStep = step.branches?.[branchKey];

      if (!nextStep) {
        throw new Error(
          `workflow.branch_missing: branch '${branchKey}' not found in step '${stepId}'`
        );
      }

      return this.executeStep(runId, nextStep, payload);
    }
  }

  private async runTask(
    stepId: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // Placeholder — connectors will plug in here
    return { [`${stepId}_result`]: true };
  }

  private async evaluateBranch(
    stepId: string,
    payload: Record<string, unknown>
  ): Promise<string> {
    // Placeholder — real logic will be added later
    return "default";
  }
}
