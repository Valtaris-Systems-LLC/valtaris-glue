// Replay engine — identity-bound: caller must be a tenant member on the
// source run's tenant.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireUser, logSecurity } from "../_shared/auth.ts";
import { buildReplayRunInsert, computeReplayResumeIndex, runReplaySequence } from "./logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = await requireUser(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const operator_uid = auth.ctx.userId;

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, key);

  try {
    const body = await req.json().catch(() => ({}));
    const source_run_id: string | undefined = body.source_run_id;
    if (!source_run_id) {
      return new Response(JSON.stringify({ error: "source_run_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { data: source } = await sb.from("workflow_runs").select("*").eq("id", source_run_id).single();
    if (!source) {
      return new Response(JSON.stringify({ error: "source run not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { data: allowed } = await sb.rpc("has_tenant_access", {
      _uid: operator_uid, _tenant_id: source.tenant_id,
    });
    if (!allowed) {
      await logSecurity({
        tenant_id: source.tenant_id, actor_user_id: operator_uid,
        category: "authz.denied", severity: "warn",
        subject_type: "run", subject_id: source_run_id,
        message: "replay denied: caller not a tenant member",
      });
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    await logSecurity({
      tenant_id: source.tenant_id, actor_user_id: operator_uid,
      category: "replay.access", subject_type: "run", subject_id: source_run_id,
      message: "replay initiated",
    });
    const { data: steps } = await sb
      .from("workflow_step_runs")
      .select("*")
      .eq("run_id", source_run_id)
      .order("step_index", { ascending: true });

    const { data: checkpoints } = await sb
      .from("workflow_checkpoints")
      .select("*")
      .eq("run_id", source_run_id)
      .order("step_index", { ascending: true });

    const resumeIndex = computeReplayResumeIndex(checkpoints ?? []);
    const correlation_id = source.correlation_id ?? crypto.randomUUID();

    const { data: replayRun } = await sb
      .from("workflow_runs")
      .insert(buildReplayRunInsert({
        source,
        sourceRunId: source_run_id,
        correlationId: correlation_id,
        resumeIndex,
      }))
      .select()
      .single();

    const run_id = replayRun!.id as string;

    const emit = (type: string, severity: string, message: string, data: Record<string, unknown> = {}, step_id: string | null = null) =>
      sb.from("workflow_events").insert({
        run_id,
        step_id,
        type,
        severity,
        source: "replay-workflow",
        message,
        data: { ...data, replay: true, source_run_id },
      });

    await emit("replay.started", "info", `Replaying ${source.workflow_name} from step ${resumeIndex}`, {
      resume_from: resumeIndex,
      total_steps: (steps ?? []).length,
    });

    void runReplaySequence({
      runId: run_id,
      sourceRunId: source_run_id,
      steps: (steps ?? []).map((step) => ({
        name: step.name,
        connector: step.connector,
        duration_ms: step.duration_ms,
      })),
      resumeIndex,
      sleep,
      persistence: {
        emit: async ({ run_id: targetRunId, step_id, type, severity, message, data }) => {
          await sb.from("workflow_events").insert({
            run_id: targetRunId,
            step_id: step_id ?? null,
            type,
            severity,
            source: "replay-workflow",
            message,
            data,
          });
        },
        insertStepRun: async (args) => {
          const { data: stepRow } = await sb
            .from("workflow_step_runs")
            .insert(args)
            .select()
            .single();
          return { id: stepRow?.id ?? null };
        },
        updateStepRun: async (id, args) => {
          await sb.from("workflow_step_runs").update(args).eq("id", id);
        },
        insertCheckpoint: async (args) => {
          await sb.from("workflow_checkpoints").insert(args);
        },
        updateRun: async (targetRunId, args) => {
          await sb.from("workflow_runs").update(args).eq("id", targetRunId);
        },
      },
    }).catch((e) => console.error("[replay-workflow] runner error", e));

    return new Response(JSON.stringify({ run_id, source_run_id, resume_from: resumeIndex }), {
      status: 202,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[replay-workflow] error", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
