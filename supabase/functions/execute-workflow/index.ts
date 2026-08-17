// execute-workflow — authenticated, version-pinned durable launch.
//
// This function owns the launch boundary only:
//
//   authenticate
//      ↓
//   resolve immutable published workflow version
//      ↓
//   authorize against version tenant
//      ↓
//   validate immutable graph
//      ↓
//   create run + root jobs
//      ↓
//   mark run running
//      ↓
//   kick durable worker
//
// Execution itself remains in run-worker.
//
// IMPORTANT:
// - workflow_version_id is the authoritative execution definition.
// - mutable workflow_dags / dag_id are not used for execution.
// - the worker is safe to kick repeatedly because job claiming is
//   responsible for concurrency control.

import { requireUser, serviceClient, logSecurity } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "POST, OPTIONS",
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

interface WorkflowVersion {
  id: string;
  definition_id: string;
  tenant_id: string;
  version: number | string;
  state: string;
  graph: WorkflowGraph | null;
  metadata?: Record<string, unknown> | null;
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
        "Content-Type":
          "application/json",
      },
    },
  );
}

function isNonEmptyString(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function normalizePayload(
  value: unknown,
): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<
      string,
      unknown
    >;
  }

  return {};
}

function validateGraph(
  graph: WorkflowGraph,
) {
  const nodes = Array.isArray(graph.nodes)
    ? graph.nodes
    : [];

  if (nodes.length === 0) {
    return {
      ok: false as const,
      error:
        "workflow version graph contains no executable nodes",
    };
  }

  const nodeIds = new Set<string>();

  for (const node of nodes) {
    if (
      !isNonEmptyString(node.id)
    ) {
      return {
        ok: false as const,
        error:
          "workflow graph contains a node without a valid id",
      };
    }

    const nodeId =
      node.id.trim();

    if (nodeIds.has(nodeId)) {
      return {
        ok: false as const,
        error:
          `workflow graph contains duplicate node id: ${nodeId}`,
      };
    }

    nodeIds.add(nodeId);
  }

  for (const node of nodes) {
    const dependencies =
      Array.isArray(
        node.dependsOn,
      )
        ? node.dependsOn
        : [];

    for (const dependency of dependencies) {
      if (
        !isNonEmptyString(
          dependency,
        )
      ) {
        return {
          ok: false as const,
          error:
            `node ${node.id} contains an invalid dependency reference`,
        };
      }

      if (
        !nodeIds.has(
          dependency.trim(),
        )
      ) {
        return {
          ok: false as const,
          error:
            `node ${node.id} references missing dependency ${dependency}`,
        };
      }
    }
  }

  const roots = nodes.filter(
    (node) =>
      Array.isArray(
        node.dependsOn,
      )
        ? node.dependsOn.length === 0
        : true,
  );

  if (roots.length === 0) {
    return {
      ok: false as const,
      error:
        "workflow version graph has no root nodes",
    };
  }

  return {
    ok: true as const,
    nodes,
    roots,
  };
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

  let runId:
    | string
    | null = null;

  let runTenantId:
    | string
    | null = null;

  try {
    const body =
      await req
        .json()
        .catch(
          () => ({}),
        );

    /*
     * ------------------------------------------------------------
     * 1. Read launch request.
     * ------------------------------------------------------------
     */

    const suppliedVersionId =
      isNonEmptyString(
        body.workflow_version_id,
      )
        ? body.workflow_version_id.trim()
        : isNonEmptyString(
              body.version_id,
            )
          ? body.version_id.trim()
          : null;

    const suppliedDefinitionId =
      isNonEmptyString(
        body.definition_id,
      )
        ? body.definition_id.trim()
        : null;

    const workflowName =
      isNonEmptyString(
        body.workflow_name,
      )
        ? body.workflow_name.trim()
        : null;

    const correlationId =
      isNonEmptyString(
        body.correlation_id,
      )
        ? body.correlation_id.trim()
        : crypto.randomUUID();

    const payload =
      normalizePayload(
        body.payload,
      );

    /*
     * ------------------------------------------------------------
     * 2. Resolve exactly one immutable workflow version.
     *
     * If the caller supplies a definition instead of a version,
     * resolve the currently published version from the publication
     * control record.
     * ------------------------------------------------------------
     */

    let resolvedVersionId =
      suppliedVersionId;

    if (
      !resolvedVersionId &&
      suppliedDefinitionId
    ) {
      const {
        data: published,
        error: publishedErr,
      } = await sb
        .from(
          "workflow_published_versions",
        )
        .select(
          "version_id, tenant_id, definition_id",
        )
        .eq(
          "definition_id",
          suppliedDefinitionId,
        )
        .maybeSingle();

      if (publishedErr) {
        throw publishedErr;
      }

      if (
        !published?.version_id
      ) {
        return json(
          {
            error:
              "definition has no published workflow version",
          },
          409,
        );
      }

      resolvedVersionId =
        published.version_id;
    }

    if (
      !resolvedVersionId
    ) {
      return json(
        {
          error:
            "workflow_version_id required; execution must be pinned to a published workflow version",
        },
        400,
      );
    }

    /*
     * ------------------------------------------------------------
     * 3. Load the immutable version.
     * ------------------------------------------------------------
     */

    const {
      data: versionRow,
      error: versionErr,
    } = await sb
      .from(
        "workflow_versions",
      )
      .select(
        [
          "id",
          "definition_id",
          "tenant_id",
          "version",
          "state",
          "graph",
          "metadata",
        ].join(","),
      )
      .eq(
        "id",
        resolvedVersionId,
      )
      .maybeSingle();

    if (versionErr) {
      throw versionErr;
    }

    if (!versionRow) {
      return json(
        {
          error:
            "workflow version not found",
          version_id:
            resolvedVersionId,
        },
        404,
      );
    }

    const version =
      versionRow as WorkflowVersion;

    /*
     * The supplied definition_id is only a selector. Once the
     * version is resolved, the version's definition_id is authoritative.
     *
     * Reject mismatches rather than silently executing a caller's
     * inconsistent request.
     */
    if (
      suppliedDefinitionId &&
      version.definition_id !==
        suppliedDefinitionId
    ) {
      return json(
        {
          error:
            "definition_id does not match workflow version",
          workflow_version_id:
            version.id,
          requested_definition_id:
            suppliedDefinitionId,
          version_definition_id:
            version.definition_id,
        },
        409,
      );
    }

    if (
      version.state !==
      "published"
    ) {
      return json(
        {
          error:
            "workflow version is not runnable",
          version_id:
            version.id,
          state:
            version.state,
        },
        409,
      );
    }

    /*
     * ------------------------------------------------------------
     * 4. Authorize against the version's tenant.
     *
     * Never trust a tenant_id supplied by the caller.
     * ------------------------------------------------------------
     */

    const {
      data: allowed,
      error: accessErr,
    } = await sb.rpc(
      "has_operator_role",
      {
        _uid:
          operatorUid,
        _tenant_id:
          version.tenant_id,
        _required:
          "operator",
      },
    );

    if (accessErr) {
      throw accessErr;
    }

    if (!allowed) {
      await logSecurity({
        tenant_id:
          version.tenant_id,
        actor_user_id:
          operatorUid,
        category:
          "authz.denied",
        severity:
          "warn",
        subject_type:
          "workflow_version",
        subject_id:
          version.id,
        message:
          "workflow execution denied: operator role required",
        details: {
          definition_id:
            version.definition_id,
          version:
            version.version,
        },
      });

      return json(
        {
          error:
            "forbidden",
        },
        403,
      );
    }

    /*
     * ------------------------------------------------------------
     * 5. Validate the immutable graph before creating anything.
     *
     * This prevents malformed published graphs from creating partial
     * execution state.
     * ------------------------------------------------------------
     */

    const graph =
      version.graph ??
      {};

    const graphValidation =
      validateGraph(graph);

    if (
      !graphValidation.ok
    ) {
      return json(
        {
          error:
            graphValidation.error,
          version_id:
            version.id,
        },
        409,
      );
    }

    const {
      nodes,
      roots,
    } =
      graphValidation;

    /*
     * ------------------------------------------------------------
     * 6. Build durable run identity.
     * ------------------------------------------------------------
     */

    const runWorkflowName =
      workflowName ??
      `workflow:${version.definition_id}:v${version.version}`;

    const now =
      new Date().toISOString();

    /*
     * IMPORTANT:
     *
     * No caller-provided dag_id is copied into workflow_runs.
     *
     * workflow_version_id is the authoritative execution reference.
     */

    const {
      data: runRow,
      error: runErr,
    } = await sb
      .from(
        "workflow_runs",
      )
      .insert({
        tenant_id:
          version.tenant_id,
        workflow_id:
          version.definition_id,
        workflow_name:
          runWorkflowName,
        workflow_version_id:
          version.id,
        state:
          "queued",
        status:
          "queued",
        correlation_id:
          correlationId,
        payload,
        started_at:
          now,
      })
      .select(
        "id, workflow_version_id, tenant_id",
      )
      .single();

    if (runErr) {
      throw runErr;
    }

    if (!runRow?.id) {
      throw new Error(
        "workflow run was not created",
      );
    }

    runId =
      runRow.id as string;

    runTenantId =
      version.tenant_id;

    /*
     * ------------------------------------------------------------
     * 7. Persist launch event.
     * ------------------------------------------------------------
     */

    const {
      error: eventErr,
    } = await sb
      .from(
        "workflow_events",
      )
      .insert({
        run_id:
          runId,
        tenant_id:
          version.tenant_id,
        type:
          "run.enqueued",
        severity:
          "info",
        source:
          "execute-workflow",
        message:
          `Run enqueued: ${runWorkflowName}`,
        data: {
          actor_user_id:
            operatorUid,
          correlation_id:
            correlationId,
          workflow_version_id:
            version.id,
          definition_id:
            version.definition_id,
          version:
            version.version,
          root_count:
            roots.length,
        },
      });

    if (eventErr) {
      throw eventErr;
    }

    /*
     * ------------------------------------------------------------
     * 8. Enqueue root jobs from the immutable version graph.
     * ------------------------------------------------------------
     */

    const rows =
      roots.map(
        (node) => ({
          run_id:
            runId,
          tenant_id:
            version.tenant_id,
          workflow_version_id:
            version.id,
          dag_node_id:
            node.id,
          state:
            "queued" as const,
          max_retries:
            typeof node.maxRetries ===
                "number" &&
              node.maxRetries >= 0
              ? node.maxRetries
              : 3,
          idempotency_key:
            `${runId}:${node.id}`,
          payload: {
            correlation_id:
              correlationId,
            ...payload,
          },
        }),
      );

    const {
      error: jobsErr,
    } = await sb
      .from(
        "workflow_jobs",
      )
      .insert(rows);

    if (jobsErr) {
      throw jobsErr;
    }

    /*
     * ------------------------------------------------------------
     * 9. Transition the run to running only after durable jobs exist.
     * ------------------------------------------------------------
     */

    const {
      error: runningErr,
    } = await sb
      .from(
        "workflow_runs",
      )
      .update({
        state:
          "running",
        status:
          "running",
      })
      .eq(
        "id",
        runId,
      )
      .eq(
        "tenant_id",
        version.tenant_id,
      )
      .eq(
        "workflow_version_id",
        version.id,
      );

    if (runningErr) {
      throw runningErr;
    }

    /*
     * ------------------------------------------------------------
     * 10. Record launch completion.
     * ------------------------------------------------------------
     */

    await logSecurity({
      tenant_id:
        version.tenant_id,
      actor_user_id:
        operatorUid,
      category:
        "workflow.launch",
      severity:
        "info",
      subject_type:
        "workflow_run",
      subject_id:
        runId,
      message:
        "workflow execution launched",
      details: {
        workflow_version_id:
          version.id,
        definition_id:
          version.definition_id,
        version:
          version.version,
        correlation_id:
          correlationId,
        root_jobs:
          rows.length,
      },
    });

    /*
     * ------------------------------------------------------------
     * 11. Kick durable worker.
     *
     * Fire-and-forget is intentional. Durable state already exists.
     * Worker-side claiming is responsible for concurrency safety.
     * ------------------------------------------------------------
     */

    const supabaseUrl =
      Deno.env.get(
        "SUPABASE_URL",
      );

    const serviceKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY",
      );

    if (
      !supabaseUrl ||
      !serviceKey
    ) {
      throw new Error(
        "Supabase worker configuration is missing",
      );
    }

    fetch(
      `${supabaseUrl}/functions/v1/run-worker`,
      {
        method:
          "POST",
        headers: {
          "Content-Type":
            "application/json",
          Authorization:
            `Bearer ${serviceKey}`,
        },
        body:
          "{}",
      },
    ).catch(
      (error) => {
        console.error(
          "[execute-workflow] worker kick failed",
          error instanceof Error
            ? error.message
            : String(error),
        );
      },
    );

    /*
     * ------------------------------------------------------------
     * 12. Return durable launch identity.
     * ------------------------------------------------------------
     */

    return json(
      {
        run_id:
          runId,
        correlation_id:
          correlationId,
        workflow_version_id:
          version.id,
        definition_id:
          version.definition_id,
        version:
          version.version,
        root_jobs:
          rows.length,
        graph_nodes:
          nodes.length,
        enqueued:
          rows.length,
        state:
          "running",
      },
      202,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error ===
            "object"
          ? JSON.stringify(
              error,
            )
          : String(error);

    console.error(
      "[execute-workflow] error",
      message,
    );

    /*
     * If the run was created but launch preparation failed, reconcile
     * the run instead of leaving it looking runnable forever.
     *
     * We intentionally do not delete the run: the failed launch is
     * valuable audit evidence.
     */
    if (
      runId &&
      runTenantId
    ) {
      try {
        await sb
          .from(
            "workflow_runs",
          )
          .update({
            state:
              "failed",
            status:
              "failed",
            ended_at:
              new Date().toISOString(),
            error:
              `Launch failed: ${message}`,
          })
          .eq(
            "id",
            runId,
          )
          .eq(
            "tenant_id",
            runTenantId,
          );

        await sb
          .from(
            "workflow_events",
          )
          .insert({
            run_id:
              runId,
            tenant_id:
              runTenantId,
            type:
              "run.launch_failed",
            severity:
              "error",
            source:
              "execute-workflow",
            message:
              "Workflow launch failed",
            data: {
              actor_user_id:
                operatorUid,
              error:
                message,
            },
          });
      } catch (
        reconciliationError
      ) {
        console.error(
          "[execute-workflow] launch reconciliation failed",
          reconciliationError instanceof
            Error
            ? reconciliationError.message
            : String(
                reconciliationError,
              ),
        );
      }
    }

    return json(
      {
        error:
          message,
        run_id:
          runId,
      },
      500,
    );
  }
});
