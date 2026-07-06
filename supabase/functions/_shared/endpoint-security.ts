import type { TenantMembership } from "./tenant.ts";

export type EndpointClassification =
  | "public ingress"
  | "authenticated user/operator"
  | "internal service/cron"
  | "admin-only";

export type AccessLevel =
  | "anonymous"
  | "tenant_user"
  | "operator"
  | "admin"
  | "internal_service";

export type EdgeFunctionName =
  | "approval-decision"
  | "control-plane"
  | "event-trigger-router"
  | "execute-api"
  | "execute-workflow"
  | "generate-workflow"
  | "load-harness"
  | "manual-launch"
  | "otel-export"
  | "platform-control"
  | "replay-workflow"
  | "rollback-executor"
  | "run-worker"
  | "runtime-validate"
  | "scale-monitor"
  | "scheduler-tick"
  | "sla-sweeper"
  | "tick-connectors"
  | "webhook-ingress"
  | "worker-health"
  | "workflow-publish";

export interface EdgeFunctionSecurityPolicy {
  classification: EndpointClassification;
  allowedAccessLevels: AccessLevel[];
}

const ALL_AUTHENTICATED_ACCESS_LEVELS: AccessLevel[] = [
  "tenant_user",
  "operator",
  "admin",
  "internal_service",
];

export const EDGE_FUNCTION_SECURITY: Record<EdgeFunctionName, EdgeFunctionSecurityPolicy> = {
  "approval-decision": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "control-plane": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "event-trigger-router": {
    classification: "internal service/cron",
    allowedAccessLevels: ["internal_service"],
  },
  "execute-api": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ALL_AUTHENTICATED_ACCESS_LEVELS,
  },
  "execute-workflow": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ALL_AUTHENTICATED_ACCESS_LEVELS,
  },
  "generate-workflow": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ALL_AUTHENTICATED_ACCESS_LEVELS,
  },
  "load-harness": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "manual-launch": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "otel-export": {
    classification: "admin-only",
    allowedAccessLevels: ["admin", "internal_service"],
  },
  "platform-control": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "replay-workflow": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ALL_AUTHENTICATED_ACCESS_LEVELS,
  },
  "rollback-executor": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "run-worker": {
    classification: "internal service/cron",
    allowedAccessLevels: ["internal_service"],
  },
  "runtime-validate": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "scale-monitor": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "scheduler-tick": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "sla-sweeper": {
    classification: "internal service/cron",
    allowedAccessLevels: ["internal_service"],
  },
  "tick-connectors": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
  "webhook-ingress": {
    classification: "public ingress",
    allowedAccessLevels: [
      "anonymous",
      "tenant_user",
      "operator",
      "admin",
      "internal_service",
    ],
  },
  "worker-health": {
    classification: "admin-only",
    allowedAccessLevels: ["admin", "internal_service"],
  },
  "workflow-publish": {
    classification: "authenticated user/operator",
    allowedAccessLevels: ["operator", "admin", "internal_service"],
  },
};

export function accessLevelFromMemberships(memberships: TenantMembership[]): AccessLevel {
  if (memberships.some((membership) => membership.role === "admin")) {
    return "admin";
  }

  if (memberships.some((membership) => membership.role === "operator")) {
    return "operator";
  }

  return "tenant_user";
}

export function isInternalServiceToken(args: {
  bearerToken?: string | null;
  serviceRoleKey?: string | null;
  internalToken?: string | null;
}): boolean {
  if (!args.bearerToken) return false;
  return args.bearerToken === args.serviceRoleKey
    || (!!args.internalToken && args.bearerToken === args.internalToken);
}

export function authorizeEndpointAccess(
  endpoint: EdgeFunctionName,
  accessLevel: AccessLevel,
): { ok: true } | { ok: false; status: number; error: string } {
  const policy = EDGE_FUNCTION_SECURITY[endpoint];
  if (policy.allowedAccessLevels.includes(accessLevel)) {
    return { ok: true };
  }

  return {
    ok: false,
    status: accessLevel === "anonymous" ? 401 : 403,
    error: accessLevel === "anonymous"
      ? `${endpoint} requires authentication`
      : `${endpoint} access denied for ${accessLevel}`,
  };
}
