// src/orchestration/api-router.ts
// Valtaris Glue — API Router
//
// Provides the HTTP routing layer for Glue:
// - POST /workflow/run
// - GET /workflow/:runId/status
// - GET /workflow/:runId/steps
// - GET /workflow/:runId/snapshots
//
// This is the public API surface for Glue.

import express from "express";
import { WorkflowRunner } from "./workflow-runner";
import { DSLBinding } from "./dsl-binding";
import { PersistenceManager } from "./persistence-manager";

export function createApiRouter(
  runner: WorkflowRunner,
  dsl: DSLBinding,
  persistence: PersistenceManager
) {
  const router = express.Router();

  // Run workflow (DSL or imperative)
  router.post("/workflow/run", async (req, res) => {
    try {
      const { workflow, payload } = req.body;

      if (!workflow) {
        return res.status(400).json({
          error: "api.missing_workflow",
        });
      }

      const runId = await dsl.run(workflow, payload ?? {});
      res.json({ runId });
    } catch (err: any) {
      res.status(500).json({
        error: "api.workflow_run_failed",
        details: err.message,
      });
    }
  });

  // Workflow status
  router.get("/workflow/:runId/status", async (req, res) => {
    const { runId } = req.params;
    const state = await persistence.loadState(runId);

    res.json({
      runId,
      state,
    });
  });

  // Workflow steps
  router.get("/workflow/:runId/steps", async (req, res) => {
    const { runId } = req.params;
    const steps = await persistence.listSteps(runId);

    res.json({
      runId,
      steps,
    });
  });

  // Workflow snapshots
  router.get("/workflow/:runId/snapshots", async (req, res) => {
    const { runId } = req.params;
    const snapshots = persistence.listSnapshots(runId);

    res.json({
      runId,
      snapshots,
    });
  });

  return router;
}
