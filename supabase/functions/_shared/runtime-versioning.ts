import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { DagGraph } from "./dag.ts";

export interface RuntimeVersionRow {
  id: string;
  definition_id: string;
  tenant_id: string;
  version: number;
  graph: DagGraph;
}

export interface RuntimeDefinitionRow {
  id: string;
  key: string;
  name: string;
  tenant_id: string;
}

export interface RuntimeLegacyDagRow {
  id: string;
  name: string;
  graph: DagGraph;
  tenant_id?: string | null;
}

export interface ResolvedExecutionSource {
  dagId: string;
  workflowName: string;
  workflowVersionId: string | null;
  graph: DagGraph;
  definitionId: string | null;
  version: number | null;
  resolutionSource: "workflow_version" | "workflow_dag";
}

export interface RuntimeResolutionGateway {
  getWorkflowVersion(versionId: string, tenantId?: string | null): Promise<RuntimeVersionRow | null>;
  getWorkflowDefinition(definitionId: string, tenantId?: string | null): Promise<RuntimeDefinitionRow | null>;
  getWorkflowDefinitionByKey(key: string, tenantId?: string | null): Promise<RuntimeDefinitionRow | null>;
  getPublishedVersionId(definitionId: string): Promise<string | null>;
  getLegacyDag(dagId: string): Promise<RuntimeLegacyDagRow | null>;
}

export async function resolveExecutionSourceWithGateway(
  gateway: RuntimeResolutionGateway,
  args: { tenantId?: string | null; dagId: string; workflowVersionId?: string | null; workflowName?: string | null },
): Promise<ResolvedExecutionSource> {
  const workflowVersionId = args.workflowVersionId ?? null;
  if (workflowVersionId) {
    const version = await gateway.getWorkflowVersion(workflowVersionId, args.tenantId);
    if (!version) {
      throw new Error(`workflow version ${workflowVersionId} not found`);
    }

    const definition = await gateway.getWorkflowDefinition(version.definition_id, args.tenantId);
    return {
      dagId: args.dagId,
      workflowName: args.workflowName ?? definition?.name ?? args.dagId,
      workflowVersionId: version.id,
      graph: version.graph,
      definitionId: version.definition_id,
      version: version.version,
      resolutionSource: "workflow_version",
    };
  }

  const definition = await gateway.getWorkflowDefinitionByKey(args.dagId, args.tenantId);
  if (definition) {
    const publishedVersionId = await gateway.getPublishedVersionId(definition.id);
    if (publishedVersionId) {
      const version = await gateway.getWorkflowVersion(publishedVersionId, args.tenantId);
      if (!version) {
        throw new Error(`published workflow version ${publishedVersionId} not found`);
      }

      return {
        dagId: args.dagId,
        workflowName: args.workflowName ?? definition.name,
        workflowVersionId: version.id,
        graph: version.graph,
        definitionId: definition.id,
        version: version.version,
        resolutionSource: "workflow_version",
      };
    }
  }

  const dag = await gateway.getLegacyDag(args.dagId);
  if (!dag || (dag.tenant_id && args.tenantId && dag.tenant_id !== args.tenantId)) {
    throw new Error(`dag ${args.dagId} not found`);
  }

  return {
    dagId: dag.id,
    workflowName: args.workflowName ?? dag.name ?? args.dagId,
    workflowVersionId: null,
    graph: dag.graph,
    definitionId: null,
    version: null,
    resolutionSource: "workflow_dag",
  };
}

export async function resolveExecutionSource(
  sb: SupabaseClient,
  args: { tenantId?: string | null; dagId: string; workflowVersionId?: string | null; workflowName?: string | null },
): Promise<ResolvedExecutionSource> {
  return resolveExecutionSourceWithGateway({
    async getWorkflowVersion(versionId, tenantId) {
      let query = sb
        .from("workflow_versions")
        .select("id,definition_id,tenant_id,version,graph")
        .eq("id", versionId);
      if (tenantId) {
        query = query.eq("tenant_id", tenantId);
      }
      const { data } = await query.maybeSingle();
      return (data as RuntimeVersionRow | null) ?? null;
    },
    async getWorkflowDefinition(definitionId, tenantId) {
      let query = sb
        .from("workflow_definitions")
        .select("id,key,name,tenant_id")
        .eq("id", definitionId);
      if (tenantId) {
        query = query.eq("tenant_id", tenantId);
      }
      const { data } = await query.maybeSingle();
      return (data as RuntimeDefinitionRow | null) ?? null;
    },
    async getWorkflowDefinitionByKey(key, tenantId) {
      let query = sb
        .from("workflow_definitions")
        .select("id,key,name,tenant_id")
        .eq("key", key);
      if (tenantId) {
        query = query.eq("tenant_id", tenantId);
      }
      const { data } = await query.maybeSingle();
      return (data as RuntimeDefinitionRow | null) ?? null;
    },
    async getPublishedVersionId(definitionId) {
      const { data } = await sb
        .from("workflow_published_versions")
        .select("version_id")
        .eq("definition_id", definitionId)
        .maybeSingle();
      return (data?.version_id as string | undefined) ?? null;
    },
    async getLegacyDag(dagId) {
      const { data } = await sb
        .from("workflow_dags")
        .select("id,name,graph,tenant_id")
        .eq("id", dagId)
        .maybeSingle();
      return (data as RuntimeLegacyDagRow | null) ?? null;
    },
  }, args);
}
