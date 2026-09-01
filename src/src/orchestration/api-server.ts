// src/orchestration/api-server.ts
// Valtaris Glue — API Server
//
// Boots the HTTP server that exposes Glue's workflow API.
// This is the main entry point for running Glue as a service.

import express from "express";
import bodyParser from "body-parser";
import { createApiRouter } from "./api-router";
import { WorkflowRunner } from "./workflow-runner";
import { DSLBinding } from "./dsl-binding";
import { PersistenceManager } from "./persistence-manager";
import { SnapshotStore } from "./persistence-snapshot";
import { StateStore } from "./state-store";
import { MemoryPersistence } from "./persistence-memory";

export class ApiServer {
  private app = express();
  private port: number;

  constructor(port = 3000) {
    this.port = port;

    this.app.use(bodyParser.json());

    // Core runtime components
    const runner = new WorkflowRunner();
    const dsl = new DSLBinding(runner);

    const persistence = new PersistenceManager(
      new MemoryPersistence(),
      new SnapshotStore(),
      new StateStore()
    );

    // Attach API routes
    const router = createApiRouter(runner, dsl, persistence);
    this.app.use("/api", router);
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`Glue API server running on port ${this.port}`);
    });
  }
}
