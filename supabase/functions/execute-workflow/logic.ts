import type { DagGraph } from "../_shared/dag.ts";

export interface ExecuteWorkflowRequestBody {
  dag_id?: string;
  workflow_name?: string;
  correlation_id?: string;
  payload?: Record<string, unknown>;
  tenant_id?: string;
}

export interface NormalizedExecuteWorkflowRequest {
  dag_id: string;
  workflow_name: string;
  correlation_id: string;
  payload: Record<string, unknown>;
  tenant_id?: string;
}

export interface EnqueuedWorkflowJob {
  run_id: string;
  tenant_id: string;
  dag_node_id: string;
  state: "queued";
  max_retries: number;
  idempotency_key: string;
  payload: Record<string, unknown>;
}

export function normalizeExecuteWorkflowRequest(
  body: ExecuteWorkflowRequestBody = {},
  generateId: () => string,
): NormalizedExecuteWorkflowRequest {
  return {
    dag_id: body.dag_id ?? "demo.live",
    workflow_name: body.workflow_name ?? "Live demo workflow",
    correlation_id: body.correlation_id ?? generateId(),
    payload: body.payload ?? {},
    tenant_id: body.tenant_id,
  };
}

export function buildRootWorkflowJobs(
  graph: DagGraph,
  runId: string,
  correlationId: string,
  tenantId: string,
  payload: Record<string, unknown>,
): EnqueuedWorkflowJob[] {
  return graph.nodes
    .filter((node) => !node.dependsOn || node.dependsOn.length === 0)
    .map((node) => ({
      run_id: runId,
      tenant_id: tenantId,
      dag_node_id: node.id,
      state: "queued" as const,
      max_retries: node.maxRetries ?? 3,
      idempotency_key: `${runId}:${node.id}`,
      payload: { correlation_id: correlationId, ...payload },
    }));
}
