import { describe, expect, it } from "vitest";
import { buildApprovalInvocation } from "../../../supabase/functions/approval-decision/logic.ts";
import { createApprovalPausePlan } from "../../../supabase/functions/run-worker/logic.ts";

describe("approval pause and resume logic", () => {
  it("pauses an approval-gated job and moves the run into waiting state", () => {
    const plan = createApprovalPausePlan({
      runId: "run-approval",
      jobId: "job-approval",
      nodeId: "review",
      nodeName: "Manager review",
      now: new Date("2026-01-01T00:00:00.000Z"),
      expiresInMs: 60_000,
    });

    expect(plan.approvalInsert).toMatchObject({
      run_id: "run-approval",
      job_id: "job-approval",
      dag_node_id: "review",
      state: "pending",
    });
    expect(plan.jobUpdate.state).toBe("delayed");
    expect(plan.runUpdate.state).toBe("waiting_for_approval");
    expect(plan.event.message).toContain("Awaiting approval");
  });

  it("maps operator approval decisions onto the correct RPC calls", () => {
    expect(buildApprovalInvocation("approval-1", "approve", "user-1")).toEqual({
      rpcName: "resume_after_approval",
      args: { _approval_id: "approval-1", _operator_uid: "user-1" },
      shouldKickWorker: true,
    });

    expect(buildApprovalInvocation("approval-1", "reject", "user-1", "policy mismatch")).toEqual({
      rpcName: "reject_approval",
      args: { _approval_id: "approval-1", _operator_uid: "user-1", _reason: "policy mismatch" },
      shouldKickWorker: false,
    });
  });
});
