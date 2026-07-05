export type ApprovalDecision = "approve" | "reject";

export interface ApprovalInvocation {
  rpcName: "resume_after_approval" | "reject_approval";
  args: Record<string, unknown>;
  shouldKickWorker: boolean;
}

export function buildApprovalInvocation(
  approvalId: string,
  decision: ApprovalDecision,
  operatorUid: string,
  reason?: string,
): ApprovalInvocation {
  if (decision === "approve") {
    return {
      rpcName: "resume_after_approval",
      args: { _approval_id: approvalId, _operator_uid: operatorUid },
      shouldKickWorker: true,
    };
  }

  return {
    rpcName: "reject_approval",
    args: { _approval_id: approvalId, _operator_uid: operatorUid, _reason: reason ?? null },
    shouldKickWorker: false,
  };
}
