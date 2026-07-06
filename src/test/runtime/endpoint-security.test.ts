import { describe, expect, it } from "vitest";
import {
  EDGE_FUNCTION_SECURITY,
  accessLevelFromMemberships,
  authorizeEndpointAccess,
  isInternalServiceToken,
} from "../../../supabase/functions/_shared/endpoint-security.ts";

describe("endpoint security policy", () => {
  it("rejects anonymous callers from hardened operational endpoints", () => {
    for (const endpoint of [
      "worker-health",
      "scheduler-tick",
      "sla-sweeper",
      "runtime-validate",
      "otel-export",
      "run-worker",
    ] as const) {
      expect(authorizeEndpointAccess(endpoint, "anonymous")).toEqual({
        ok: false,
        status: 401,
        error: `${endpoint} requires authentication`,
      });
    }
  });

  it("blocks tenant users from admin and internal endpoints", () => {
    expect(authorizeEndpointAccess("worker-health", "tenant_user")).toEqual({
      ok: false,
      status: 403,
      error: "worker-health access denied for tenant_user",
    });
    expect(authorizeEndpointAccess("run-worker", "tenant_user")).toEqual({
      ok: false,
      status: 403,
      error: "run-worker access denied for tenant_user",
    });
    expect(authorizeEndpointAccess("runtime-validate", "tenant_user")).toEqual({
      ok: false,
      status: 403,
      error: "runtime-validate access denied for tenant_user",
    });
  });

  it("preserves operator and admin access where expected", () => {
    expect(authorizeEndpointAccess("scheduler-tick", "operator")).toEqual({ ok: true });
    expect(authorizeEndpointAccess("runtime-validate", "operator")).toEqual({ ok: true });
    expect(authorizeEndpointAccess("worker-health", "admin")).toEqual({ ok: true });
    expect(authorizeEndpointAccess("otel-export", "admin")).toEqual({ ok: true });
  });

  it("accepts internal bearer tokens for cron and worker callers", () => {
    expect(isInternalServiceToken({
      bearerToken: "service-role-token",
      serviceRoleKey: "service-role-token",
      internalToken: null,
    })).toBe(true);
    expect(isInternalServiceToken({
      bearerToken: "cron-bearer-token",
      serviceRoleKey: "service-role-token",
      internalToken: "cron-bearer-token",
    })).toBe(true);
    expect(authorizeEndpointAccess("run-worker", "internal_service")).toEqual({ ok: true });
    expect(authorizeEndpointAccess("sla-sweeper", "internal_service")).toEqual({ ok: true });
  });

  it("keeps public ingress callable where intended", () => {
    expect(EDGE_FUNCTION_SECURITY["webhook-ingress"].classification).toBe("public ingress");
    expect(authorizeEndpointAccess("webhook-ingress", "anonymous")).toEqual({ ok: true });
  });

  it("distinguishes tenant users from operator and admin memberships", () => {
    expect(accessLevelFromMemberships([{ tenant_id: "tenant-a", role: "observer" }])).toBe("tenant_user");
    expect(accessLevelFromMemberships([{ tenant_id: "tenant-a", role: "operator" }])).toBe("operator");
    expect(accessLevelFromMemberships([{ tenant_id: "tenant-a", role: "admin" }])).toBe("admin");
  });
});
