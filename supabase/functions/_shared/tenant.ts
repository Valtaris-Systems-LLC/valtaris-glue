export interface TenantMembership {
  tenant_id: string;
  role: string;
}

const TENANT_KEYS = ["active_tenant_id", "tenant_id", "org_id", "organization_id"] as const;

function candidateValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function collectCandidate(map: unknown, key: string): string | null {
  if (!map || typeof map !== "object") return null;
  return candidateValue((map as Record<string, unknown>)[key]);
}

export function claimTenantIds(claims: Record<string, unknown>): string[] {
  const nested = [claims, claims.app_metadata, claims.user_metadata];
  const ids = new Set<string>();

  for (const source of nested) {
    for (const key of TENANT_KEYS) {
      const value = collectCandidate(source, key);
      if (value) ids.add(value);
    }
  }

  return [...ids];
}

export function resolveTenantBinding(args: {
  memberships: TenantMembership[];
  requestedTenantId?: string | null;
  claimTenantIds?: string[];
}): string | null {
  const tenantIds = new Set(args.memberships.map((membership) => membership.tenant_id));
  if (tenantIds.size === 0) return null;

  if (args.requestedTenantId) {
    return tenantIds.has(args.requestedTenantId) ? args.requestedTenantId : null;
  }

  for (const tenantId of args.claimTenantIds ?? []) {
    if (tenantIds.has(tenantId)) return tenantId;
  }

  return tenantIds.size === 1 ? [...tenantIds][0] : null;
}

export function hasAnyAdminRole(memberships: TenantMembership[]): boolean {
  return memberships.some((membership) => membership.role === "admin");
}
