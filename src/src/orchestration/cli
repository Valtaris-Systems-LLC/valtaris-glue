// src/orchestration/cli.ts
// Valtaris Glue — CLI Interface
//
// Provides a command-line interface for Glue:
// - glue run <workflow.json> [payload.json]
// - glue status <runId>
// - glue steps <runId>
// - glue snapshots <runId>
//
// This is the developer-facing CLI for interacting with Glue.

import fs from "fs";
import path from "path";
import { WorkflowRunner } from "./workflow-runner";
import { DSLBinding } from "./dsl-binding";
import { PersistenceManager } from "./persistence-manager";
import { SnapshotStore } from "./persistence-snapshot";
import { StateStore } from "./state-store";
import { MemoryPersistence } from "./persistence-memory";

export class GlueCLI {
  private runner = new WorkflowRunner();
  private dsl = new DSLBinding(this.runner);
  private persistence = new PersistenceManager(
    new MemoryPersistence(),
    new SnapshotStore(),
    new StateStore()
  );

  async run(argv: string[]) {
    const [command, arg1, arg2] = argv;

    switch (command) {
      case "run":
        return await this.runWorkflow(arg1, arg2);

      case "status":
        return await this.showStatus(arg1);

      case "steps":
        return await this.showSteps(arg1);

      case "snapshots":
        return await this.showSnapshots(arg1);

      default:
        console.log("Unknown command:", command);
        console.log("Commands: run, status, steps, snapshots");
    }
  }

  private async runWorkflow(workflowPath: string, payloadPath?: string) {
    if (!workflowPath) {
      console.error("Missing workflow file");
      return;
    }

    const workflow = JSON.parse(
      fs.readFileSync(path.resolve(workflowPath), "utf-8")
    );

    const payload = payloadPath
      ? JSON.parse(fs.readFileSync(path.resolve(payloadPath), "utf-8"))
      : {};

    const runId = await this.dsl.run(workflow, payload);

    console.log("Workflow started:");
    console.log("Run ID:", runId);
  }

  private async showStatus(runId: string) {
    const state = await this.persistence.loadState(runId);
    console.log("Workflow Status:", state);
  }

  private async showSteps(runId: string) {
    const steps = await this.persistence.listSteps(runId);
    console.log("Workflow Steps:", steps);
  }

  private async showSnapshots(runId: string) {
    const snapshots = this.persistence.listSnapshots(runId);
    console.log("Workflow Snapshots:", snapshots);
  }
}
