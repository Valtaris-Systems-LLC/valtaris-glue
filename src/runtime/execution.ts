import { supabase } from "@/integrations/supabase/client";
import { requireTenantId, resolveTenantScope } from "@/lib/tenantScope";
import type { RunState, WorkflowRun } from "./types";

export async function listRecentRuns(limit = 50): Promise<WorkflowRun[]> {
  const scope = await resolveTenantScope({ dagId: "demo.live" });
  const tenantId = requireTenantId(scope);
  const { data, error } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as WorkflowRun[];
}

export async function transitionRun(id: string, state: RunState, patch: Record<string, unknown> = {}) {
  const { error } = await supabase
    .from("workflow_runs")
    .update({ state, ...patch } as never)
    .eq("id", id);
  if (error) throw error;
}

export async function executeLiveWorkflow(workflowName = "Live demo workflow", dagId = "demo.live") {
  const scope = await resolveTenantScope({ dagId });
  const tenantId = requireTenantId(scope);
  const { data, error } = await supabase.functions.invoke("execute-workflow", {
    body: { workflow_name: workflowName, dag_id: dagId, tenant_id: tenantId },
  });
  if (error) throw error;
  return data as { run_id: string };
}
