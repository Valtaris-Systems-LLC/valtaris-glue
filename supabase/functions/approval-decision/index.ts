// Operator approval decision — identity-bound.
//
// POST {
//   approval_id: string,
//   decision: "approve" | "reject",
//   reason?: string
// }
//
// The acting operator is always derived from the authenticated JWT.
// The database RPC remains the authority for tenant/role/approval-state
// validation and mutation.

import {
  requireUser,
  serviceClient,
  logSecurity,
} from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "POST, OPTIONS",
};

type Decision = "approve" | "reject";

interface ApprovalDecisionRequest {
  approval_id?: unknown;
  decision?: unknown;
  reason?: unknown;
}

function json(
  body: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...cors,
        "Content-Type": "application/json",
      },
    },
  );
}

function cleanString(
  value: unknown,
): string | null {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0
    ? trimmed
    : null;
}

function isDecision(
  value: unknown,
): value is Decision {
  return (
    value === "approve" ||
    value === "reject"
  );
}

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

async function kickWorker() {
  const url =
    Deno.env.get("SUPABASE_URL");

  const key =
    Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY",
    );

  if (!url || !key) {
    throw new Error(
      "worker runtime configuration missing",
    );
  }

  await fetch(
    `${url}/functions/v1/run-worker`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
        Authorization:
          `Bearer ${key}`,
      },
      body: "{}",
    },
  );
}

Deno.serve(async (req) => {
  if (
    req.method === "OPTIONS"
  ) {
    return new Response(
      "ok",
      { headers: cors },
    );
  }

  if (
    req.method !== "POST"
  ) {
    return json(
      {
        error:
          "method not allowed",
      },
      405,
    );
  }

  /*
   * ------------------------------------------------------------
   * 1. Authenticate the operator.
   *
   * Never accept actor identity from the request body.
   * ------------------------------------------------------------
   */

  const auth =
    await requireUser(req);

  if (!auth.ok) {
    return json(
      {
        error: auth.error,
      },
      auth.status,
    );
  }

  const operatorUid =
    auth.ctx.userId;

  const sb =
    serviceClient();

  /*
   * ------------------------------------------------------------
   * 2. Parse and validate the request.
   * ------------------------------------------------------------
   */

  let body:
    | ApprovalDecisionRequest;

  try {
    body =
      (await req.json()) as
        ApprovalDecisionRequest;
  } catch {
    return json(
      {
        error:
          "invalid JSON body",
      },
      400,
    );
  }

  const approvalId =
    cleanString(
      body.approval_id,
    );

  const decision =
    body.decision;

  const reason =
    cleanString(
      body.reason,
    );

  if (!approvalId) {
    return json(
      {
        error:
          "approval_id required",
      },
      400,
    );
  }

  if (
    !isDecision(decision)
  ) {
    return json(
      {
        error:
          "decision must be approve or reject",
      },
      400,
    );
  }

  /*
   * Keep rejection reasons bounded. This prevents an operator from
   * accidentally turning the approval record/audit trail into an
   * unbounded payload sink.
   */
  if (
    reason &&
    reason.length > 2000
  ) {
    return json(
      {
        error:
          "reason exceeds maximum length",
      },
      400,
    );
  }

  /*
   * ------------------------------------------------------------
   * 3. Execute the identity-bound database transition.
   *
   * The RPC is intentionally responsible for:
   *   - locating the approval
   *   - checking tenant membership
   *   - checking operator privilege
   *   - validating current approval state
   *   - mutating the approval/job/run atomically
   *
   * The edge function never performs those mutations directly.
   * ------------------------------------------------------------
   */

  const rpcName =
    decision === "approve"
      ? "resume_after_approval"
      : "reject_approval";

  const rpcArgs: Record<
    string,
    unknown
  > =
    decision === "approve"
      ? {
          _approval_id:
            approvalId,
          _operator_uid:
            operatorUid,
        }
      : {
          _approval_id:
            approvalId,
          _operator_uid:
            operatorUid,
          _reason:
            reason,
        };

  const {
    error: rpcError,
  } = await sb.rpc(
    rpcName,
    rpcArgs,
  );

  if (rpcError) {
    /*
     * Do not classify every database error as authorization failure.
     *
     * The RPC is the source of truth for the actual transition. A
     * permission/state/tenant rejection is client-visible as 403,
     * while an unexpected database/runtime failure is a 500.
     */
    const message =
      rpcError.message ??
      "approval transition failed";

    const lowered =
      message.toLowerCase();

    const authorizationFailure =
      lowered.includes(
        "forbidden",
      ) ||
      lowered.includes(
        "not authorized",
      ) ||
      lowered.includes(
        "unauthorized",
      ) ||
      lowered.includes(
        "operator role",
      ) ||
      lowered.includes(
        "permission denied",
      ) ||
      lowered.includes(
        "tenant",
      );

    const invalidState =
      lowered.includes(
        "already approved",
      ) ||
      lowered.includes(
        "already rejected",
      ) ||
      lowered.includes(
        "expired",
      ) ||
      lowered.includes(
        "not pending",
      );

    await logSecurity({
      actor_user_id:
        operatorUid,
      category:
        authorizationFailure
          ? "authz.denied"
          : "approval.transition_failed",
      severity:
        authorizationFailure
          ? "warn"
          : "error",
      subject_type:
        "approval",
      subject_id:
        approvalId,
      message:
        authorizationFailure
          ? `approval ${decision} denied`
          : `approval ${decision} transition failed`,
      details: {
        decision,
        rpc:
          rpcName,
        error:
          message,
      },
    });

    if (
      authorizationFailure
    ) {
      return json(
        {
          error:
            "forbidden",
        },
        403,
      );
    }

    if (invalidState) {
      return json(
        {
          error:
            message,
          approval_id:
            approvalId,
          decision,
        },
        409,
      );
    }

    console.error(
      "[approval-decision] RPC error",
      {
        approval_id:
          approvalId,
        decision,
        rpc: rpcName,
        error: message,
      },
    );

    return json(
      {
        error:
          "approval transition failed",
      },
      500,
    );
  }

  /*
   * ------------------------------------------------------------
   * 4. Record the successful operator action.
   *
   * The actual durable approval mutation already happened inside the
   * RPC. This event is supplemental observability/security telemetry.
   * ------------------------------------------------------------
   */

  await logSecurity({
    actor_user_id:
      operatorUid,
    category:
      `approval.${decision}`,
    severity:
      "info",
    subject_type:
      "approval",
    subject_id:
      approvalId,
    message:
      `approval ${decision} completed`,
    details: {
      decision,
      reason:
        decision === "reject"
          ? reason
          : null,
    },
  });

  /*
   * ------------------------------------------------------------
   * 5. Kick the durable worker.
   *
   * Approval and rejection both change durable workflow state:
   * approval can release execution, while rejection can unblock
   * terminal run processing/dead-letter handling.
   *
   * The database transition has already been committed, so failure
   * to kick the worker does NOT invalidate the operator decision.
   * The queue remains durable and another worker invocation can drain it.
   * ------------------------------------------------------------
   */

  try {
    await kickWorker();
  } catch (error) {
    console.error(
      "[approval-decision] worker kick failed",
      errorMessage(error),
    );

    await logSecurity({
      actor_user_id:
        operatorUid,
      category:
        "worker.kick_failed",
      severity:
        "warn",
      subject_type:
        "approval",
      subject_id:
        approvalId,
      message:
        "approval decision committed but worker kick failed",
      details: {
        decision,
        error:
          errorMessage(error),
      },
    });
  }

  return json(
    {
      ok: true,
      approval_id:
        approvalId,
      decision,
      actor_user_id:
        operatorUid,
    },
    200,
  );
});
