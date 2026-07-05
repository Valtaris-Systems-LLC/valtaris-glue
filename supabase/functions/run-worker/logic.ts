import type { ConnectorError } from "../_shared/connectors.ts";
import { type DagGraph, isTerminal, readyNodes, type NodeState } from "../_shared/dag.ts";
import { DEFAULT_POLICY, nextBackoffMs, shouldRetry, type RetryPolicy } from "../_shared/retry.ts";

export interface RuntimeJobState {
  dag_node_id: string;
  state: string;
}

export interface ApprovalPausePlan {
  expiresAt: string;
  approvalInsert: {
    run_id: string;
    job_id: string;
    dag_node_id: string;
    state: "pending";
    expires_at: string;
    requested_at: string;
  };
  jobUpdate: {
    state: "delayed";
    backoff_until: string;
    scheduled_at: string;
    worker_id: null;
    started_at: null;
    updated_at: string;
  };
  runUpdate: {
    state: "waiting_for_approval";
  };
  event: {
    type: "approval.requested";
    severity: "warn";
    message: string;
    data: {
      node_id: string;
      expires_at: string;
    };
  };
  auditLog: {
    actor: "worker";
    action: "approval.request";
    subject_type: "approval";
    details: {
      run_id: string;
      job_id: string;
      node_id: string;
    };
  };
}

export interface RetryPlan {
  nextAttempt: number;
  backoffMs: number;
  retryUntil: string;
  stepUpdate: {
    state: "retrying";
    retry_count: number;
    error: string;
  };
  jobUpdate: {
    state: "retrying";
    retry_attempt: number;
    backoff_until: string;
    scheduled_at: string;
    worker_id: null;
    started_at: null;
    error: string;
    updated_at: string;
  };
  event: {
    type: "step.retry";
    severity: "warn";
    message: string;
    data: {
      backoff_ms: number;
      kind?: string;
    };
  };
}

export interface DeadLetterPlan {
  stepUpdate: {
    state: "failed";
    ended_at: string;
    duration_ms: number;
    error: string;
  };
  jobUpdate: {
    state: "dead_letter";
    completed_at: string;
    error: string;
    updated_at: string;
  };
  deadLetterInsert: {
    job_id: string;
    run_id: string;
    dag_node_id: string;
    attempts: number;
    last_error: string;
    payload: Record<string, unknown>;
  };
  incidentInsert: {
    run_id: string;
    severity: "error";
    category: "dead_letter";
    connector: string;
    summary: string;
  };
  event: {
    type: "step.failed";
    severity: "error";
    message: string;
    data: {
      kind?: string;
      attempts: number;
    };
  };
}

export interface DownstreamRunContext {
  correlation_id?: string | null;
  workflow_version_id?: string | null;
  tenant_id?: string | null;
}

export interface DownstreamJobInsert {
  run_id: string;
  tenant_id?: string | null;
  workflow_version_id?: string | null;
  dag_node_id: string;
  state: "queued";
  max_retries: number;
  idempotency_key: string;
  payload: {
    correlation_id?: string | null;
  };
}

export interface RunFinalization {
  update: {
    state: "failed" | "completed";
    status: "failed" | "completed";
    ended_at: string;
    duration_ms: number;
    error: string | null;
    result: { nodes: number } | null;
  };
  event: {
    type: "run.failed" | "run.completed";
    severity: "error" | "info";
    message: string;
    data: {
      duration_ms: number;
    };
  };
}

export function buildNodeStates(graph: DagGraph, jobs: RuntimeJobState[]): Record<string, NodeState> {
  const states: Record<string, NodeState> = {};
  for (const node of graph.nodes) {
    states[node.id] = "pending";
  }
  for (const job of jobs) {
    if (job.state === "completed") {
      states[job.dag_node_id] = "completed";
    } else if (job.state === "dead_letter" || job.state === "failed") {
      states[job.dag_node_id] = "failed";
    } else if (job.state === "running") {
      states[job.dag_node_id] = "running";
    } else {
      states[job.dag_node_id] = "queued";
    }
  }
  return states;
}

export function createApprovalPausePlan(args: {
  runId: string;
  jobId: string;
  nodeId: string;
  nodeName: string;
  now?: Date;
  expiresInMs?: number;
}): ApprovalPausePlan {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (args.expiresInMs ?? 30 * 60_000)).toISOString();
  const requestedAt = now.toISOString();

  return {
    expiresAt,
    approvalInsert: {
      run_id: args.runId,
      job_id: args.jobId,
      dag_node_id: args.nodeId,
      state: "pending",
      expires_at: expiresAt,
      requested_at: requestedAt,
    },
    jobUpdate: {
      state: "delayed",
      backoff_until: expiresAt,
      scheduled_at: expiresAt,
      worker_id: null,
      started_at: null,
      updated_at: requestedAt,
    },
    runUpdate: { state: "waiting_for_approval" },
    event: {
      type: "approval.requested",
      severity: "warn",
      message: `⏸ Awaiting approval: ${args.nodeName}`,
      data: { node_id: args.nodeId, expires_at: expiresAt },
    },
    auditLog: {
      actor: "worker",
      action: "approval.request",
      subject_type: "approval",
      details: { run_id: args.runId, job_id: args.jobId, node_id: args.nodeId },
    },
  };
}

export function createRetryPlan(args: {
  jobId: string;
  nodeName: string;
  retryAttempt: number;
  maxRetries: number;
  error: ConnectorError;
  now?: Date;
  policy?: RetryPolicy;
  backoffFactory?: (attempt: number, policy: RetryPolicy) => number;
}): RetryPlan | null {
  const policy = { ...(args.policy ?? DEFAULT_POLICY), maxRetries: args.maxRetries };
  const nextAttempt = args.retryAttempt + 1;
  if (!shouldRetry(args.error, nextAttempt, policy)) {
    return null;
  }

  const backoffMs = (args.backoffFactory ?? nextBackoffMs)(nextAttempt, policy);
  const now = args.now ?? new Date();
  const retryUntil = new Date(now.getTime() + backoffMs).toISOString();
  const errorMessage = args.error.message || "unknown";
  const updatedAt = now.toISOString();

  return {
    nextAttempt,
    backoffMs,
    retryUntil,
    stepUpdate: {
      state: "retrying",
      retry_count: nextAttempt,
      error: errorMessage,
    },
    jobUpdate: {
      state: "retrying",
      retry_attempt: nextAttempt,
      backoff_until: retryUntil,
      scheduled_at: retryUntil,
      worker_id: null,
      started_at: null,
      error: errorMessage,
      updated_at: updatedAt,
    },
    event: {
      type: "step.retry",
      severity: "warn",
      message: `↻ ${args.nodeName} retry ${nextAttempt}/${policy.maxRetries} in ${backoffMs}ms`,
      data: { backoff_ms: backoffMs, kind: args.error.kind },
    },
  };
}

export function createDeadLetterPlan(args: {
  jobId: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  connector: string;
  nextAttempt: number;
  payload: Record<string, unknown>;
  latencyMs: number;
  error?: ConnectorError;
  now?: Date;
}): DeadLetterPlan {
  const now = (args.now ?? new Date()).toISOString();
  const errorMessage = args.error?.message ?? "failed";

  return {
    stepUpdate: {
      state: "failed",
      ended_at: now,
      duration_ms: args.latencyMs,
      error: errorMessage,
    },
    jobUpdate: {
      state: "dead_letter",
      completed_at: now,
      error: errorMessage,
      updated_at: now,
    },
    deadLetterInsert: {
      job_id: args.jobId,
      run_id: args.runId,
      dag_node_id: args.nodeId,
      attempts: args.nextAttempt,
      last_error: errorMessage,
      payload: args.payload,
    },
    incidentInsert: {
      run_id: args.runId,
      severity: "error",
      category: "dead_letter",
      connector: args.connector,
      summary: `Step "${args.nodeName}" dead-lettered after ${args.nextAttempt} attempts: ${errorMessage}`,
    },
    event: {
      type: "step.failed",
      severity: "error",
      message: `✗ ${args.nodeName} dead-lettered (${args.error?.kind ?? "unknown"})`,
      data: { kind: args.error?.kind, attempts: args.nextAttempt },
    },
  };
}

export function buildDownstreamJobInserts(args: {
  graph: DagGraph;
  jobs: RuntimeJobState[];
  runId: string;
  completedNodeId: string;
  runContext: DownstreamRunContext;
}): DownstreamJobInsert[] {
  const states = buildNodeStates(args.graph, args.jobs);
  return readyNodes(args.graph, states)
    .filter((node) => node.id !== args.completedNodeId)
    .map((node) => ({
      run_id: args.runId,
      tenant_id: args.runContext.tenant_id,
      workflow_version_id: args.runContext.workflow_version_id ?? null,
      dag_node_id: node.id,
      state: "queued" as const,
      max_retries: node.maxRetries ?? 3,
      idempotency_key: `${args.runId}:${node.id}`,
      payload: { correlation_id: args.runContext.correlation_id },
    }));
}

export function deriveRunFinalization(args: {
  graph: DagGraph;
  jobs: RuntimeJobState[];
  startedAt: string;
  now?: Date;
}): RunFinalization | null {
  const states = buildNodeStates(args.graph, args.jobs);
  const terminal = isTerminal(args.graph, states);
  if (!terminal.done) {
    return null;
  }

  const endedAt = args.now ?? new Date();
  const durationMs = endedAt.getTime() - new Date(args.startedAt).getTime();
  const failed = terminal.failed;

  return {
    update: {
      state: failed ? "failed" : "completed",
      status: failed ? "failed" : "completed",
      ended_at: endedAt.toISOString(),
      duration_ms: durationMs,
      error: failed ? "One or more steps failed" : null,
      result: failed ? null : { nodes: args.graph.nodes.length },
    },
    event: {
      type: failed ? "run.failed" : "run.completed",
      severity: failed ? "error" : "info",
      message: failed ? `Run failed in ${durationMs}ms` : `Run completed in ${durationMs}ms`,
      data: { duration_ms: durationMs },
    },
  };
}
