// Operator approval decision — identity-bound.
// POST { approval_id, decision: 'approve'|'reject', reason? }
// The acting operator is derived from the JWT, not a body param.

import { requireUser, serviceClient, logSecurity } from "../_shared/auth.ts";
import { buildApprovalInvocation } from "./logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = await requireUser(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const operator_uid = auth.ctx.userId;
  const sb = serviceClient();

  try {
    const body = await req.json();
    const { approval_id, decision, reason } = body;
    if (!approval_id || !["approve", "reject"].includes(decision)) {
      return new Response(JSON.stringify({ error: "approval_id and decision required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const invocation = buildApprovalInvocation(approval_id, decision, operator_uid, reason);

    const { error } = await sb.rpc(invocation.rpcName, invocation.args);
    if (error) {
      await logSecurity({
        actor_user_id: operator_uid,
        category: "authz.denied",
        severity: "warn",
        subject_type: "approval",
        subject_id: approval_id,
        message: `approval ${decision} rejected by RLS/role check`,
        details: { error: error.message },
      });
      return new Response(JSON.stringify({ error: error.message }), {
        status: 403, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (invocation.shouldKickWorker) {
      // kick the worker so the released job is drained immediately
      const url = Deno.env.get("SUPABASE_URL")!;
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      fetch(`${url}/functions/v1/run-worker`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: "{}",
      }).catch(() => {});
    }

    return new Response(JSON.stringify({ ok: true, decision }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
