// src/orchestration/rpc-server.ts
// Valtaris Glue — RPC Server
//
// Provides a lightweight RPC interface for Glue:
// - runWorkflow(workflow, payload)
// - getStatus(runId)
// - getSteps(runId)
// - getSnapshots(runId)
//
// This is the programmatic API surface for Glue.

import { WorkflowRunner } from "./workflow-runner";
import { DSLBinding } from "./dsl-binding";
import { PersistenceManager } from "./persistence-manager";

export class RPCServer {
  constructor(
    private runner: WorkflowRunner,
    private dsl: DSLBinding,
    private persistence: PersistenceManager
  ) {}

  async runWorkflow(workflow: any, payload: Record<string, unknown> = {}) {
    return await this.dsl.run(workflow, payload);
  }

  async getStatus(runId: string) {
    return await this.persistence.loadState(runId);
  }

  async getSteps(runId: string) {
    return await this.persistence.listSteps(runId);
  }

  async getSnapshots(runId: string) {
    return this.persistence.listSnapshots(runId);
  }
}
