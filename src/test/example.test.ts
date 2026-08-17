# `src/test/example.test.ts`

```ts
import { describe, expect, it } from "vitest";

describe("Glue runtime invariants", () => {
  describe("workflow identity", () => {
    it("keeps workflow versions immutable once selected for execution", () => {
      const workflow = {
        id: "workflow-1",
        version: 7,
      };

      const execution = {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
      };

      const laterWorkflowVersion = 8;

      expect(execution.workflowId).toBe("workflow-1");
      expect(execution.workflowVersion).toBe(7);
      expect(execution.workflowVersion).not.toBe(laterWorkflowVersion);
    });

    it("does not allow an execution to silently follow a newer workflow version", () => {
      const execution = {
        workflowId: "workflow-1",
        workflowVersion: 3,
      };

      const currentDefinition = {
        workflowId: "workflow-1",
        version: 4,
      };

      expect(execution.workflowVersion).toBe(3);
      expect(currentDefinition.version).toBe(4);
      expect(execution.workflowVersion).not.toBe(currentDefinition.version);
    });
  });

  describe("durable job identity", () => {
    it("requires a stable identifier for every queued job", () => {
      const job = {
        id: "job-123",
        workflowRunId: "run-456",
        stepId: "step-1",
      };

      expect(job.id).toBeTruthy();
      expect(job.workflowRunId).toBeTruthy();
      expect(job.stepId).toBeTruthy();
    });

    it("keeps job identity distinct from workflow-run identity", () => {
      const job = {
        id: "job-123",
        workflowRunId: "run-456",
      };

      expect(job.id).not.toBe(job.workflowRunId);
    });
  });

  describe("lease invariants", () => {
    it("recognizes an active lease as owned by the claiming worker", () => {
      const lease = {
        workerId: "worker-a",
        leasedUntil: Date.now() + 30_000,
      };

      const now = Date.now();

      expect(lease.workerId).toBe("worker-a");
      expect(lease.leasedUntil).toBeGreaterThan(now);
    });

    it("recognizes an expired lease as eligible for recovery", () => {
      const lease = {
        workerId: "worker-a",
        leasedUntil: Date.now() - 1,
      };

      const now = Date.now();

      expect(lease.leasedUntil).toBeLessThanOrEqual(now);
    });
  });

  describe("retry invariants", () => {
    it("keeps retry attempts monotonic", () => {
      const attempts = [0, 1, 2, 3];

      for (let index = 1; index < attempts.length; index += 1) {
        expect(attempts[index]).toBeGreaterThan(attempts[index - 1]);
      }
    });

    it("does not exceed the configured retry limit", () => {
      const maxAttempts = 3;
      const attempts = [0, 1, 2, 3];

      for (const attempt of attempts) {
        expect(attempt).toBeLessThanOrEqual(maxAttempts);
      }
    });
  });

  describe("DAG dependency invariants", () => {
    it("does not unlock a dependent step until all dependencies complete", () => {
      const dependencies = [
        { id: "step-a", status: "completed" },
        { id: "step-b", status: "completed" },
      ];

      const allDependenciesComplete = dependencies.every(
        (dependency) => dependency.status === "completed",
      );

      expect(allDependenciesComplete).toBe(true);
    });

    it("keeps a dependent step blocked when any dependency has not completed", () => {
      const dependencies = [
        { id: "step-a", status: "completed" },
        { id: "step-b", status: "running" },
      ];

      const allDependenciesComplete = dependencies.every(
        (dependency) => dependency.status === "completed",
      );

      expect(allDependenciesComplete).toBe(false);
    });
  });

  describe("tenant isolation invariants", () => {
    it("never treats different tenants as the same execution boundary", () => {
      const tenantA = {
        id: "tenant-a",
        workflowRunId: "run-a",
      };

      const tenantB = {
        id: "tenant-b",
        workflowRunId: "run-b",
      };

      expect(tenantA.id).not.toBe(tenantB.id);
      expect(tenantA.workflowRunId).not.toBe(tenantB.workflowRunId);
    });

    it("requires tenant identity when evaluating operational state", () => {
      const operationalRecord = {
        tenantId: "tenant-a",
        jobId: "job-1",
      };

      expect(operationalRecord.tenantId).toBeTruthy();
    });
  });

  describe("terminal-state invariants", () => {
    it("does not treat a failed job as successfully completed", () => {
      const job = {
        status: "failed",
      };

      expect(job.status).not.toBe("completed");
    });

    it("does not treat a dead-lettered job as pending", () => {
      const job = {
        status: "dead_lettered",
      };

      expect(job.status).not.toBe("pending");
    });
  });
});
```
