// supabase/functions/run-worker/index.ts
// Valtaris Glue — Durable Worker Runtime (Generation 3)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const LEASE_MS = 30000;
const HEARTBEAT_MS = 10000;
const MAX_ATTEMPTS = 3;

async function claimNextJob() {
  const { data, error } = await supabase.rpc("claim_next_job", {});
  if (error) {
    console.error("claim_next_job error", error);
    return null;
  }
  return data ?? null;
}

async function renewLease(jobId: string) {
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  await supabase
    .from("workflow_jobs")
    .update({
      lease_expires_at: leaseExpiresAt,
      claimed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

async function loadRun(runId: string) {
  const { data } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("id", runId)
    .single();
  return data ?? null;
}

async function loadVersion(versionId: string) {
  const { data } = await supabase
    .from("workflow_versions")
    .select("*")
    .eq("id", versionId)
    .single();
  return data ?? null;
}

async function getConnectorAdapter(connector: string | undefined) {
  if (!connector) return null;
  const { data } = await supabase.functions.invoke("connector-registry", {
    body: { connector },
  });
  return data?.adapter ?? null;
}

async function executeStep(job: any, node: any, adapter: any) {
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

  if (error) throw new Error("step-execution-failed");
}

async function createDownstream(runId: string, version: any, stepId: string, outcome: string) {
  const node = version.graph.nodes.find((n: any) => n.id === stepId);
  if (!node) return;

  let nextIds: string[] = [];
  if (outcome === "success") nextIds = node.next ?? [];
  if (outcome === "failure") nextIds = node.on_failure ?? [];
  if (outcome === "approval") nextIds = node.on_approval ?? [];
  if (outcome === "compensation") nextIds = node.on_compensation ?? [];

  for (const nextId of nextIds) {
    await supabase.rpc("ensure_downstream_job", {
      p_run_id: runId,
      p_step_id: nextId,
    });
  }
}

async function completeJob(jobId: string) {
  await supabase.functions.invoke("job-lifecycle", {
    body: { job_id: jobId, action: "complete" },
  });
}

async function failJob(jobId: string, reason: string) {
  await supabase.functions.invoke("job-lifecycle", {
    body: { job_id: jobId, action: "fail", error: reason },
  });
}

async function deadLetter(jobId: string, reason: string) {
  await supabase.functions.invoke("dead-letter", {
    body: { job_id: jobId, error: reason },
  });
}

async function handleApproval(job: any, version: any) {
  const { data: approval } = await supabase
    .from("workflow_approvals")
    .select("*")
    .eq("run_id", job.run_id)
    .eq("step_id", job.step_id)
    .single();

  // No approval yet → create pending + delay job
  if (!approval) {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await supabase.from("workflow_approvals").insert({
      run_id: job.run_id,
      step_id: job.step_id,
      tenant_id: job.tenant_id,
      state: "pending",
      created_at: new Date(),
      expires_at: expiresAt,
    });

    await supabase
      .from("workflow_jobs")
      .update({
        state: "delayed",
        scheduled_at: expiresAt,
      })
      .eq("id", job.id);

    return { status: "delayed" };
  }

  // Expired?
  if (
    approval.state === "pending" &&
    approval.expires_at &&
    new Date(approval.expires_at) < new Date()
  ) {
    await supabase
      .from("workflow_approvals")
      .update({
        state: "expired",
        expired_at: new Date(),
      })
      .eq("id", approval.id);

    await deadLetter(job.id, "approval-expired");
    await createDownstream(job.run_id, version, job.step_id, "failure");

    return { status: "dead" };
  }

  // Rejected?
  if (approval.state === "rejected") {
    await deadLetter(job.id, "approval-rejected");
    await createDownstream(job.run_id, version, job.step_id, "failure");
    return { status: "dead" };
  }

  // Pending → do not execute
  if (approval.state === "pending") {
    return { status: "delayed" };
  }

  // Approved → continue
  return { status: "approved" };
}

async function processJob(job: any) {
  const run = await loadRun(job.run_id);
  if (!run) return await failJob(job.id, "run-not-found");

  const version = await loadVersion(run.workflow_version_id);
  if (!version) return await failJob(job.id, "version-not-found");

  const node = version.graph.nodes.find((n: any) => n.id === job.step_id);
  if (!node) return await deadLetter(job.id, "step-not-in-graph");

  // Approval gate
  if (node.type === "approval") {
    const approvalStatus = await handleApproval(job, version);
    if (approvalStatus.status !== "approved") return;
  }

  // Lease heartbeat
  await renewLease(job.id);
  let active = true;
  const heartbeat = setInterval(() => {
    if (active) renewLease(job.id);
  }, HEARTBEAT_MS);

  try {
    const adapter = await getConnectorAdapter(node.connector);
    if (node.connector && !adapter) throw new Error("connector-adapter-not-found");

    await executeStep(job, node, adapter);

    await completeJob(job.id);
    await createDownstream(job.run_id, version, job.step_id, "success");
  } catch (err) {
    console.error("processJob error", err);

    const nextAttempt = job.attempt + 1;

    if (nextAttempt >= MAX_ATTEMPTS) {
      await deadLetter(job.id, "max-attempts-exceeded");
      await createDownstream(job.run_id, version, job.step_id, "failure");
    } else {
      await failJob(job.id, "execution-error");
    }
  } finally {
    active = false;
    clearInterval(heartbeat);
  }
}

serve(async () => {
  const job = await claimNextJob();

  if (!job) {
    return new Response(JSON.stringify({ status: "no-job" }), { status: 200 });
  }

  await processJob(job);

  return new Response(
    JSON.stringify({
      status: "processed",
      job_id: job.id,
      run_id: job.run_id,
      step_id: job.step_id,
    }),
    { status: 200 }
  );
});
