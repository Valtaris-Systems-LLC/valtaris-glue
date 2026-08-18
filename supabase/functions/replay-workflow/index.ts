// supabase/functions/run-worker/index.ts
// Valtaris Glue — Durable Worker Runtime (Generation 2)
//
// This worker is responsible for:
//   - transactional job claiming
//   - lease-based execution
//   - connector adapter invocation
//   - downstream job creation (idempotent)
//   - retry handling
//   - DLQ routing
//   - compensation routing
//   - stuck/expired lease recovery
//
// Authority chain:
//   scheduler → run-worker → job-lifecycle → step-lifecycle → execute-step → connector-adapter
//
// Contract:
//   - Only one worker may claim a given job at a time.
//   - Downstream jobs are created idempotently per (run_id, step_id).
//   - Leases are renewed for long-running jobs.
//   - Expired leases are recovered by repair/stuck-run detectors.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const LEASE_MS = 30000; // 30 seconds
const HEARTBEAT_MS = 10000; // renew lease every 10 seconds

type WorkflowJob = {
  id: string;
  run_id: string;
  step_id: string;
  state: string;
  attempt: number;
  payload: any;
  lease_expires_at: string | null;
  claimed_at: string | null;
};

type WorkflowRun = {
  id: string;
  workflow_version_id: string;
  state: string;
};

type WorkflowVersion = {
  id: string;
  graph: {
    nodes: Array<{
      id: string;
      type: string;
      connector?: string;
      next?: string[];
      on_failure?: string[];
      on_approval?: string[];
      on_compensation?: string[];
    }>;
  };
};

async function claimNextJob(): Promise<WorkflowJob | null> {
  // This function relies on a transactional RPC or SKIP LOCKED semantics
  // implemented in the database layer. Here we call a stored procedure
  // that atomically:
  //   - finds a pending job
  //   - marks it as leased
  //   - returns it to the worker
  //
  // You must ensure the database function enforces:
  //   - state = 'pending'
  //   - claimed_at IS NULL
  //   - lease_expires_at IS NULL OR < now
  //   - FOR UPDATE SKIP LOCKED
  const { data, error } = await supabase.rpc("claim_next_job", {});

  if (error) {
    console.error("claim_next_job error", error);
    return null;
  }

  if (!data) return null;
  return data as WorkflowJob;
}

async function renewLease(jobId: string) {
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  const { error } = await supabase
    .from("workflow_jobs")
    .update({
      lease_expires_at: leaseExpiresAt,
      claimed_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (error) {
    console.error("renewLease error", error);
  }
}

async function loadRun(runId: string): Promise<WorkflowRun | null> {
  const { data, error } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (error) {
    console.error("loadRun error", error);
    return null;
  }

  return data as WorkflowRun;
}

async function loadVersion(versionId: string): Promise<WorkflowVersion | null> {
  const { data, error } = await supabase
    .from("workflow_versions")
    .select("*")
    .eq("id", versionId)
    .single();

  if (error) {
    console.error("loadVersion error", error);
    return null;
  }

  return data as WorkflowVersion;
}

async function getConnectorAdapter(connector: string | undefined) {
  if (!connector) return null;

  // Connector registry is responsible for mapping connector IDs to adapters.
  // This is typically implemented as a Supabase function or a static map.
  const { data, error } = await supabase.functions.invoke("connector-registry", {
    body: { connector },
  });

  if (error) {
    console.error("connector-registry error", error);
    return null;
  }

  return data?.adapter ?? null;
}

async function executeConnector(adapter: any, job: WorkflowJob, node: any) {
  // The adapter is expected to expose an "execute" method over RPC.
  // We call connector-wrapper, which in turn calls the adapter.
  const { data, error } = await supabase.functions.invoke("connector-wrapper", {
    body: {
      adapter,
      run_id: job.run_id,
      step_id: job.step_id,
      job_id: job.id,
      payload: job.payload,
      node,
    },
  });

  if (error) {
    console.error("connector-wrapper error", error);
    throw new Error("connector-execution-failed");
  }

  return data;
}

async function createDownstreamJobs(
  runId: string,
  version: WorkflowVersion,
  currentNodeId: string,
  outcome: "success" | "failure" | "approval" | "compensation"
) {
  const node = version.graph.nodes.find((n) => n.id === currentNodeId);
  if (!node) return;

  let nextIds: string[] = [];

  if (outcome === "success") {
    nextIds = node.next ?? [];
  } else if (outcome === "failure") {
    nextIds = node.on_failure ?? [];
  } else if (outcome === "approval") {
    nextIds = node.on_approval ?? [];
  } else if (outcome === "compensation") {
    nextIds = node.on_compensation ?? [];
  }

  if (!nextIds.length) return;

  for (const nextId of nextIds) {
    // Idempotent downstream job creation:
    //   - unique constraint on (run_id, step_id)
    //   - insert only if not exists
    const { error } = await supabase.rpc("ensure_downstream_job", {
      p_run_id: runId,
      p_step_id: nextId,
    });

    if (error) {
      console.error("ensure_downstream_job error", error);
    }
  }
}

async function completeJob(jobId: string) {
  const { error } = await supabase.functions.invoke("job-lifecycle", {
    body: { job_id: jobId, action: "complete" },
  });

  if (error) {
    console.error("job-lifecycle complete error", error);
  }
}

async function failJob(jobId: string, reason: string) {
  const { error } = await supabase.functions.invoke("job-lifecycle", {
    body: { job_id: jobId, action: "fail", error: reason },
  });

  if (error) {
    console.error("job-lifecycle fail error", error);
  }
}

async function deadLetterJob(jobId: string, reason: string) {
  const { error } = await supabase.functions.invoke("dead-letter", {
    body: { job_id: jobId, error: reason },
  });

  if (error) {
    console.error("dead-letter error", error);
  }
}

async function compensateRun(runId: string, stepId: string | null) {
  const { error } = await supabase.functions.invoke("compensate-step", {
    body: { run_id: runId, step_id: stepId, payload: {} },
  });

  if (error) {
    console.error("compensate-step error", error);
  }
}

async function processJob(job: WorkflowJob) {
  const run = await loadRun(job.run_id);
  if (!run) {
    await failJob(job.id, "run-not-found");
    return;
  }

  const version = await loadVersion(run.workflow_version_id);
  if (!version) {
    await failJob(job.id, "version-not-found");
    return;
  }

  const node = version.graph.nodes.find((n) => n.id === job.step_id);
  if (!node) {
    await deadLetterJob(job.id, "step-not-in-graph");
    return;
  }

  // Renew lease before starting execution
  await renewLease(job.id);

  // Heartbeat loop: renew lease periodically while executing
  let heartbeatActive = true;
  const heartbeat = setInterval(async () => {
    if (!heartbeatActive) return;
    await renewLease(job.id);
  }, HEARTBEAT_MS);

  try {
    // Execute step via step-lifecycle → execute-step → connector-adapter
    const adapter = await getConnectorAdapter(node.connector);
    if (!adapter && node.connector) {
      throw new Error("connector-adapter-not-found");
    }

    const { error } = await supabase.functions.invoke("execute-step", {
      body: {
        run_id: job.run_id,
        step_id: job.step_id,
        job_id: job.id,
        node,
        adapter,
        payload: job.payload,
      },
    });

    if (error) {
      console.error("execute-step error", error);
      throw new Error("step-execution-failed");
    }

    // Mark job completed
    await completeJob(job.id);

    // Create downstream jobs (success path)
    await createDownstreamJobs(job.run_id, version, job.step_id, "success");
  } catch (err) {
    console.error("processJob error", err);

    // Retry or DLQ based on attempt count
    const maxAttempts = 3;
    const attempt = job.attempt ?? 0;

    if (attempt + 1 >= maxAttempts) {
      await deadLetterJob(job.id, "max-attempts-exceeded");
      await createDownstreamJobs(job.run_id, version, job.step_id, "failure");
    } else {
      await failJob(job.id, "execution-error");
    }
  } finally {
    heartbeatActive = false;
    clearInterval(heartbeat);
  }
}

serve(async () => {
  // Claim next job transactionally
  const job = await claimNextJob();

  if (!job) {
    return new Response(
      JSON.stringify({
        status: "no-job-available",
      }),
      { status: 200 }
    );
  }

  await processJob(job);

  return new Response(
    JSON.stringify({
      status: "job-processed",
      job_id: job.id,
      run_id: job.run_id,
      step_id: job.step_id,
    }),
    { status: 200 }
  );
});
