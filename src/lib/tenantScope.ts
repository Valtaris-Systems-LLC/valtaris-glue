import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export interface TenantMembership {
  tenant_id: string;
  role: string;
}

export interface TenantScope {
  tenantId: string | null;
  tenantIds: string[];
  isAdmin: boolean;
}

export interface RealtimeBinding {
  table: string;
  filter?: string;
}

const TENANT_KEYS = ["active_tenant_id", "tenant_id", "org_id", "organization_id"] as const;

function readMetadataValue(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function userTenantCandidates(user: Pick<User, "app_metadata" | "user_metadata">): string[] {
  const values = new Set<string>();
  const sources = [user.app_metadata, user.user_metadata];

  for (const source of sources) {
    for (const key of TENANT_KEYS) {
      const value = readMetadataValue(source, key);
      if (value) values.add(value);
    }
  }

  return [...values];
}

export function selectTenantScope(args: {
  memberships: TenantMembership[];
  candidateTenantIds?: string[];
  dagTenantId?: string | null;
}): TenantScope {
  const tenantIds = [...new Set(args.memberships.map((membership) => membership.tenant_id))];
  const isAdmin = args.memberships.some((membership) => membership.role === "admin");

  const preferredTenantId = args.candidateTenantIds?.find((tenantId) => tenantIds.includes(tenantId))
    ?? (args.dagTenantId && tenantIds.includes(args.dagTenantId) ? args.dagTenantId : null)
    ?? (tenantIds.length === 1 ? tenantIds[0] : null);

  return {
    tenantId: preferredTenantId,
    tenantIds,
    isAdmin,
  };
}

export function tenantRealtimeFilter(tenantId: string | null): string | undefined {
  return tenantId ? `tenant_id=eq.${tenantId}` : undefined;
}

export function buildControlPlaneBindings(scope: TenantScope): RealtimeBinding[] {
  const bindings: RealtimeBinding[] = [];
  if (scope.isAdmin) {
    bindings.push({ table: "worker_registry" });
  }
  if (scope.tenantId) {
    bindings.push({ table: "queue_partitions", filter: tenantRealtimeFilter(scope.tenantId) });
  }
  return bindings;
}

export function buildLiveRunsBindings(scope: TenantScope): RealtimeBinding[] {
  return scope.tenantId
    ? [{ table: "workflow_runs", filter: tenantRealtimeFilter(scope.tenantId) }]
    : [];
}

export function buildObservabilityBindings(scope: TenantScope): RealtimeBinding[] {
  const bindings: RealtimeBinding[] = [];
  if (scope.tenantId) {
    const filter = tenantRealtimeFilter(scope.tenantId);
    bindings.push({ table: "sla_breaches", filter });
    bindings.push({ table: "workflow_jobs", filter });
  }
  if (scope.isAdmin) {
    bindings.push({ table: "worker_heartbeats" });
  }
  return bindings;
}

export async function resolveTenantScope(options: { dagId?: string | null } = {}): Promise<TenantScope> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { tenantId: null, tenantIds: [], isAdmin: false };
  }

  const [membershipResult, dagResult] = await Promise.all([
    supabase.from("tenant_members").select("tenant_id, role").eq("user_id", user.id),
    options.dagId
      ? supabase.from("workflow_dags").select("tenant_id").eq("id", options.dagId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (membershipResult.error) throw membershipResult.error;
  if (dagResult.error) throw dagResult.error;

  return selectTenantScope({
    memberships: (membershipResult.data ?? []) as TenantMembership[],
    candidateTenantIds: userTenantCandidates(user),
    dagTenantId: dagResult.data?.tenant_id ?? null,
  });
}

export function requireTenantId(scope: TenantScope): string {
  if (!scope.tenantId) {
    throw new Error("Tenant context is required for this action");
  }
  return scope.tenantId;
}
