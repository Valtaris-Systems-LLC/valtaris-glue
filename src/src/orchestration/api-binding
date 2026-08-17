// src/orchestration/api-binding.ts
// Valtaris Glue — API Binding Layer
//
// Connects the API layer to the workflow runtime:
// - wires HTTP API → WorkflowRunner
// - wires RPC API → WorkflowRunner
// - exposes unified API surface
//
// This is the glue between the API layer and the orchestration engine.

import { ApiServer } from "./api-server";
import { RPCServer } from "./rpc-server";
import { WorkflowRunner } from "./workflow-runner";
import { DSLBinding } from "./dsl-binding";
import { PersistenceManager } from "./persistence-manager";
import { SnapshotStore } from "./persistence-snapshot";
import { StateStore } from "./state-store";
import { MemoryPersistence } from "./persistence-memory";

export class ApiBinding {
  public api: ApiServer;
  public rpc: RPCServer;

  constructor(port = 3000) {
    const runner = new WorkflowRunner();
    const dsl = new DSLBinding(runner);

    const persistence = new PersistenceManager(
      new MemoryPersistence(),
      new SnapshotStore(),
      new StateStore()
    );

    this.api = new ApiServer(port);
    this.rpc = new RPCServer(runner, dsl, persistence);
  }

  start() {
    this.api.start();
    console.log("Glue RPC server initialized");
  }
}
