import { describe, expect, it } from "vitest";
import { resolveTenantBinding } from "../../../supabase/functions/_shared/tenant.ts";
import {
  buildControlPlaneBindings,
  buildLiveRunsBindings,
  buildObservabilityBindings,
  selectTenantScope,
} from "@/lib/tenantScope";

describe("tenant isolation helpers", () => {
  it("blocks tenant A from binding execute-workflow to tenant B", () => {
    const tenantId = resolveTenantBinding({
      memberships: [{ tenant_id: "tenant-a", role: "operator" }],
      requestedTenantId: "tenant-b",
      claimTenantIds: [],
    });

    expect(tenantId).toBeNull();
  });

  it("preserves operator access for a permitted tenant binding", () => {
    const tenantId = resolveTenantBinding({
      memberships: [{ tenant_id: "tenant-a", role: "operator" }],
      requestedTenantId: "tenant-a",
      claimTenantIds: [],
    });

    expect(tenantId).toBe("tenant-a");
  });

  it("scopes control-plane and observability subscriptions to the active tenant", () => {
    const scope = selectTenantScope({
      memberships: [{ tenant_id: "tenant-a", role: "operator" }],
      candidateTenantIds: [],
    });

    expect(buildControlPlaneBindings(scope)).toEqual([
      { table: "queue_partitions", filter: "tenant_id=eq.tenant-a" },
    ]);
    expect(buildLiveRunsBindings(scope)).toEqual([
      { table: "workflow_runs", filter: "tenant_id=eq.tenant-a" },
    ]);
    expect(buildObservabilityBindings(scope)).toEqual([
      { table: "sla_breaches", filter: "tenant_id=eq.tenant-a" },
      { table: "workflow_jobs", filter: "tenant_id=eq.tenant-a" },
    ]);
  });

  it("retains admin worker visibility while tenant-scoping operational streams", () => {
    const scope = selectTenantScope({
      memberships: [
        { tenant_id: "tenant-a", role: "admin" },
        { tenant_id: "tenant-b", role: "operator" },
      ],
      candidateTenantIds: ["tenant-a"],
    });

    expect(buildControlPlaneBindings(scope)).toEqual([
      { table: "worker_registry" },
      { table: "queue_partitions", filter: "tenant_id=eq.tenant-a" },
    ]);
    expect(buildObservabilityBindings(scope)).toEqual([
      { table: "sla_breaches", filter: "tenant_id=eq.tenant-a" },
      { table: "workflow_jobs", filter: "tenant_id=eq.tenant-a" },
      { table: "worker_heartbeats" },
    ]);
  });
});
