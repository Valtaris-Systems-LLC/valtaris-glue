// execute-workflow — authenticated, version-pinned enqueue endpoint.
//
// Creates a workflow_run pinned to an immutable published workflow version,
// enqueues the root DAG nodes from that version's graph, then triggers the
// durable worker.
//
// Execution itself remains in run-worker. This function is responsible only
// for authenticated launch + durable run/job creation.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireUser, serviceClient } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface DagNode {
  id: string;
  name?: string;
  dependsOn?: string[];
  maxRetries?: number;
  timeoutMs?: number;
  [key: string]: unknown;
}

interface WorkflowGraph {
  nodes?: DagNode[];
  edges?: Array<Record<string, unknown>>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const auth = await requireUser(req);

  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  const operatorUid = auth.ctx.userId;
  const sb = serviceClient();

  try {
    const body = await req.json().catch(() => ({}));

    const workflowVersionId =
      body.workflow_version_id ??
      body.version_id ??
      null;

    const definitionId =
      body.definition_id ??
      null;

    const workflowName =
      typeof body.workflow_name === "string" && body.workflow_name.trim()
        ? body.workflow_name.trim()
        : null;

    const correlationId =
      typeof body.correlation_id === "string" && body.correlation_id.trim()
        ? body.correlation_id.trim()
        : crypto.randomUUID();

    const payload =
      body.payload !== null &&
      typeof body.payload === "object" &&
      !Array.isArray(body.payload)
        ? body.payload
        : {};

    /*
     * A run must resolve to an immutable published workflow version.
     *
     * If the caller supplies definition_id instead of version_id, resolve
     * the definition's current published version atomically from the
     * workflow_published_versions control record.
     */
    let resolvedVersionId: string | null =
      typeof workflowVersionId === "string" && workflowVersionId.trim()
        ? workflowVersionId.trim()
        : null;

    if (!resolvedVersionId && typeof definitionId === "string" && definitionId.trim()) {
      const { data: published, error: publishedErr } = await sb
        .from("workflow_published_versions")
        .select("version_id, tenant_id")
        .eq("definition_id", definitionId.trim())
        .maybeSingle();

      if (publishedErr) {
        throw publishedErr;
      }

      if (!published?.version_id) {
        return json(
          { error: "definition has no published workflow version" },
          409,
        );
      }

      resolvedVersionId = published.version_id;
    }

    if (!resolvedVersionId) {
      return json(
        {
          error:
            "workflow_version_id required; execution must be pinned to a published workflow version",
        },
        400,
      );
    }

    /*
     * Resolve the immutable version itself.
     *
     * The graph comes from workflow_versions rather than workflow_dags.
     * Published/archived/deprecated versions are immutable by database
     * trigger, so the graph used here cannot silently change underneath
     * this launch request.
     */
    const { data: version, error: versionErr } = await sb
      .from("workflow_versions")
      .select(
        "id, definition_id, tenant_id, version, state, graph, metadata",
      )
      .eq("id", resolvedVersionId)
      .maybeSingle();

    if (versionErr) {
      throw versionErr;
    }

    if (!version) {
      return json({ error: "workflow version not found" }, 404);
    }

    if (version.state !== "published") {
      return json(
        {
          error: "workflow version is not runnable",
          version_id: version.id,
          state: version.state,
        },
        409,
      );
    }

    /*
     * Authorization is bound to the version's tenant, never to a tenant_id
     * supplied by the caller.
     */
    const { data: allowed, error: accessErr } = await sb.rpc(
      "has_operator_role",
      {
        _uid: operatorUid,
        _tenant_id: version.tenant_id,
        _required: "operator",
      },
    );

    if (accessErr) {
      throw accessErr;
    }

    if (!allowed) {
      await sb.from("security_events").insert({
        tenant_id: version.tenant_id,
        actor_user_id: operatorUid,
        category: "authz.denied",
        severity: "warn",
        subject_type: "workflow_version",
        subject_id: version.id,
        message: "workflow execution denied: operator role required",
        details: {
          definition_id: version.definition_id,
          version: version.version,
        },
      });

      return json({ error: "forbidden" }, 403);
    }

    const graph = (version.graph ?? {}) as WorkflowGraph;
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];

    if (nodes.length === 0) {
      return json(
        {
          error: "workflow version graph contains no executable nodes",
          version_id: version.id,
        },
        409,
      );
    }

    /*
     * Root nodes are derived from the immutable published version graph.
     * This is intentionally done before any job rows are created so the run
     * begins with the same graph definition identified by workflow_version_id.
     */
    const roots = nodes.filter(
      (node) =>
        typeof node.id === "string" &&
        node.id.length > 0 &&
        (!node.dependsOn || node.dependsOn.length === 0),
    );

    if (roots.length === 0) {
      return json(
        {
          error: "workflow version graph has no root nodes",
          version_id: version.id,
        },
        409,
      );
    }

    const runWorkflowName =
      workflowName ??
      `workflow:${version.definition_id}:v${version.version}`;

    /*
     * dag_id remains accepted as optional legacy metadata for the current
     * worker path. Swap 2 will make run-worker resolve the graph from
     * workflow_version_id first, eliminating mutable DAG dependence.
     */
    const legacyDagId =
      typeof body.dag_id === "string" && body.dag_id.trim()
        ? body.dag_id.trim()
        : null;

    const { data: runRow, error: runErr } = await sb
      .from("workflow_runs")
      .insert({
        tenant_id: version.tenant_id,
        workflow_id: version.definition_id,
        workflow_name: runWorkflowName,
        dag_id: legacyDagId,
        workflow_version_id: version.id,
        state: "queued",
        status: "queued",
        correlation_id: correlationId,
        payload,
        started_at: new Date().toISOString(),
      })
      .select("id, workflow_version_id, tenant_id")
      .single();

    if (runErr) {
      throw runErr;
    }

    const runId = runRow.id as string;

    const { error: eventErr } = await sb.from("workflow_events").insert({
      run_id: runId,
      tenant_id: version.tenant_id,
      type: "run.enqueued",
      severity: "info",
      source: "execute-workflow",
      message: `Run enqueued: ${runWorkflowName}`,
      data: {
        correlation_id: correlationId,
        workflow_version_id: version.id,
        definition_id: version.definition_id,
        version: version.version,
      },
    });

    if (eventErr) {
      throw eventErr;
    }

    const rows = roots.map((node) => ({
      run_id: runId,
      tenant_id: version.tenant_id,
      workflow_version_id: version.id,
      dag_node_id: node.id,
      state: "queued" as const,
      max_retries:
        typeof node.maxRetries === "number" && node.maxRetries >= 0
          ? node.maxRetries
          : 3,
      idempotency_key: `${runId}:${node.id}`,
      payload: {
        correlation_id: correlationId,
        ...payload,
      },
    }));

    const { error: jobsErr } = await sb
      .from("workflow_jobs")
      .insert(rows);

    if (jobsErr) {
      throw jobsErr;
    }

    const { error: runningErr } = await sb
      .from("workflow_runs")
      .update({
        state: "running",
        status: "running",
      })
      .eq("id", runId)
      .eq("workflow_version_id", version.id);

    if (runningErr) {
      throw runningErr;
    }

    /*
     * Kick the durable worker. This remains fire-and-forget because the
     * workflow state is already persisted before the worker is invoked.
     * Multiple kicks are safe because claim_next_job() uses row locking.
     */
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    fetch(`${url}/functions/v1/run-worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: "{}",
    }).catch((error) => {
      console.error(
        "[execute-workflow] worker kick failed",
        error instanceof Error ? error.message : String(error),
      );
    });

    return json(
      {
        run_id: runId,
        correlation_id: correlationId,
        workflow_version_id: version.id,
        definition_id: version.definition_id,
        version: version.version,
        enqueued: rows.length,
      },
      202,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object"
          ? JSON.stringify(error)
          : String(error);

    console.error("[execute-workflow] error", message);

    return json({ error: message }, 500);
  }
});
