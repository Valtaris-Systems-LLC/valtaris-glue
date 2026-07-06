// Shared auth helper for operator edge functions.
// Reads the caller's JWT, validates it via getClaims(), returns the user id.
// Used by control-plane, approval-decision, replay-workflow.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { claimTenantIds, hasAnyAdminRole, resolveTenantBinding, type TenantMembership } from "./tenant.ts";

export interface AuthContext {
  userId: string;
  authHeader: string;
  claims: Record<string, unknown>;
}

export interface TenantBindingContext extends AuthContext {
  tenantId: string;
  memberships: TenantMembership[];
  isAdmin: boolean;
}

export async function requireUser(req: Request): Promise<
  { ok: true; ctx: AuthContext } | { ok: false; status: number; error: string }
> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "missing bearer token" };
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await sb.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    return { ok: false, status: 401, error: "invalid token" };
  }

  return {
    ok: true,
    ctx: {
      userId: data.claims.sub as string,
      authHeader,
      claims: data.claims as Record<string, unknown>,
    },
  };
}

export async function requireTenantBinding(
  req: Request,
  requestedTenantId?: string | null,
): Promise<{ ok: true; ctx: TenantBindingContext } | { ok: false; status: number; error: string }> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth;

  const sb = serviceClient();
  const { data, error } = await sb
    .from("tenant_members")
    .select("tenant_id, role")
    .eq("user_id", auth.ctx.userId);

  if (error) {
    return { ok: false, status: 500, error: error.message };
  }

  const memberships = (data ?? []) as TenantMembership[];
  if (memberships.length === 0) {
    return { ok: false, status: 403, error: "tenant membership required" };
  }

  const claimIds = claimTenantIds(auth.ctx.claims);
  const tenantId = resolveTenantBinding({
    memberships,
    requestedTenantId,
    claimTenantIds: claimIds,
  });

  if (!tenantId) {
    if (requestedTenantId) {
      return { ok: false, status: 403, error: "tenant access denied" };
    }
    return { ok: false, status: 400, error: "tenant binding required" };
  }

  return {
    ok: true,
    ctx: {
      ...auth.ctx,
      tenantId,
      memberships,
      isAdmin: hasAnyAdminRole(memberships),
    },
  };
}

/** Service-role client used to bypass RLS for runtime-internal writes. */
export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

/** Append a security event (uses service role — bypasses RLS). */
export async function logSecurity(args: {
  tenant_id?: string | null;
  actor_user_id?: string | null;
  category: string;
  severity?: "info" | "warn" | "error";
  subject_type?: string;
  subject_id?: string;
  message?: string;
  details?: Record<string, unknown>;
}) {
  try {
    await serviceClient().from("security_events").insert({
      tenant_id: args.tenant_id ?? null,
      actor_user_id: args.actor_user_id ?? null,
      category: args.category,
      severity: args.severity ?? "info",
      subject_type: args.subject_type ?? null,
      subject_id: args.subject_id ?? null,
      message: args.message ?? null,
      details: args.details ?? {},
    });
  } catch (_) {
    // never let telemetry failures break operator actions
  }
}
