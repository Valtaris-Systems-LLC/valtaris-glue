import { describe, expect, it } from "vitest";
import {
  resolveExecutionSourceWithGateway,
  type RuntimeDefinitionRow,
  type RuntimeLegacyDagRow,
  type RuntimeResolutionGateway,
  type RuntimeVersionRow,
} from "../../../supabase/functions/_shared/runtime-versioning.ts";

function createGateway(args: {
  definitions?: RuntimeDefinitionRow[];
  versions?: RuntimeVersionRow[];
  published?: Record<string, string>;
  dags?: RuntimeLegacyDagRow[];
}): RuntimeResolutionGateway {
  const definitions = args.definitions ?? [];
  const versions = args.versions ?? [];
  const published = args.published ?? {};
  const dags = args.dags ?? [];

  return {
    async getWorkflowVersion(versionId, tenantId) {
      return versions.find((version) => version.id === versionId && (!tenantId || version.tenant_id === tenantId)) ?? null;
    },
    async getWorkflowDefinition(definitionId, tenantId) {
      return definitions.find((definition) => definition.id === definitionId && (!tenantId || definition.tenant_id === tenantId)) ?? null;
    },
    async getWorkflowDefinitionByKey(key, tenantId) {
      return definitions.find((definition) => definition.key === key && (!tenantId || definition.tenant_id === tenantId)) ?? null;
    },
    async getPublishedVersionId(definitionId) {
      return published[definitionId] ?? null;
    },
    async getLegacyDag(dagId) {
      return dags.find((dag) => dag.id === dagId) ?? null;
    },
  };
}

describe("runtime version resolution", () => {
  it("executes the published version unchanged after legacy DAG edits", async () => {
    const resolved = await resolveExecutionSourceWithGateway(createGateway({
      definitions: [{ id: "def-1", key: "orders", name: "Orders", tenant_id: "tenant-1" }],
      versions: [{
        id: "wv-published",
        definition_id: "def-1",
        tenant_id: "tenant-1",
        version: 3,
        graph: { nodes: [{ id: "published-node", name: "Published node", connector: "internal" }] },
      }],
      published: { "def-1": "wv-published" },
      dags: [{ id: "orders", name: "Orders legacy", tenant_id: "tenant-1", graph: { nodes: [{ id: "draft-node", name: "Draft node", connector: "internal" }] } }],
    }), {
      tenantId: "tenant-1",
      dagId: "orders",
    });

    expect(resolved.workflowVersionId).toBe("wv-published");
    expect(resolved.resolutionSource).toBe("workflow_version");
    expect(resolved.graph.nodes.map((node) => node.id)).toEqual(["published-node"]);
  });

  it("falls back to legacy workflow_dags when no published version exists", async () => {
    const resolved = await resolveExecutionSourceWithGateway(createGateway({
      dags: [{ id: "demo.live", name: "Legacy demo", tenant_id: null, graph: { nodes: [{ id: "legacy-root", name: "Legacy root", connector: "internal" }] } }],
    }), {
      tenantId: "tenant-1",
      dagId: "demo.live",
    });

    expect(resolved.workflowVersionId).toBeNull();
    expect(resolved.resolutionSource).toBe("workflow_dag");
    expect(resolved.graph.nodes.map((node) => node.id)).toEqual(["legacy-root"]);
  });

  it("resolves the explicitly pinned version for rollback and worker execution", async () => {
    const resolved = await resolveExecutionSourceWithGateway(createGateway({
      definitions: [{ id: "def-1", key: "orders", name: "Orders", tenant_id: "tenant-1" }],
      versions: [
        {
          id: "wv-old",
          definition_id: "def-1",
          tenant_id: "tenant-1",
          version: 1,
          graph: { nodes: [{ id: "rollback-node", name: "Rollback node", connector: "internal", compensation: { action: "refund" } }] },
        },
        {
          id: "wv-new",
          definition_id: "def-1",
          tenant_id: "tenant-1",
          version: 2,
          graph: { nodes: [{ id: "current-node", name: "Current node", connector: "internal" }] },
        },
      ],
      published: { "def-1": "wv-new" },
      dags: [{ id: "orders", name: "Orders legacy", tenant_id: "tenant-1", graph: { nodes: [{ id: "legacy-node", name: "Legacy node", connector: "internal" }] } }],
    }), {
      tenantId: "tenant-1",
      dagId: "orders",
      workflowVersionId: "wv-old",
    });

    expect(resolved.workflowVersionId).toBe("wv-old");
    expect(resolved.graph.nodes.map((node) => node.id)).toEqual(["rollback-node"]);
  });
});
