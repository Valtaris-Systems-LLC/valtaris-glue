# Valtaris Glue — Implementation Status

Honest matrix of what is shipped vs. work-in-progress vs. planned. Updated
alongside the runtime; not aspirational.

## REAL — production behavior in place

- Durable job queue (`workflow_jobs`, `claim_next_job`, partitions, leases, DLQ)
- Worker runtime (`run-worker`, registry, heartbeats, draining, lease renewal)
- DAG executor (parallel fan-out, branch, approval, rollback nodes)
- Retry / backoff (classified errors, jittered exponential)
- Checkpoints + observational replay (`workflow_checkpoints`, pinned-version replays)
- Telemetry stream (`workflow_events` + realtime channels)
- Telemetry rollups (`aggregate_telemetry`, cron-scheduled)
- SLA breach detection (`detect_sla_breaches`, `workflow_incidents`)
- Approvals (tenant-scoped, signed, replay-safe via `decision_id`)
- Rollback / compensation (reverse-walk over checkpoints)
- Circuit breakers (per-connector, half-open probing)
- Tenant isolation (`tenant_id` propagation + RLS + `has_tenant_access` / `has_operator_role` on execution, control-plane, and realtime paths)
- Workflow versioning (draft → published → archived, publish-gate validation)
- External triggering (webhook, scheduler, event-router edge functions)
- Workflow templates + connector catalog + deployment validation
- Distributed tracing (`trace_spans` + OTLP-compatible export)
- Operator console (Command Center, Workflow Studio, Runtime Inspector, Platform, Docs)

## PARTIAL — primitives exist, end-to-end gaps remain

- **Connector adapter coverage.** Stripe / OpenAI / SendGrid execute against
  real APIs when secrets are present. Slack, Twilio, Salesforce return
  realistic mock responses by default; happy-path only tested in mock mode.
- **Multi-region routing.** `region` columns are populated; the scheduler
  does not yet enforce region-affine job claims.
- **Worker host model.** Workers run as Supabase edge functions, bounded by
  edge runtime limits. A long-lived host (Fly Machine / Cloud Run) is
  designed but not deployed.
- **Load test harness.** `load-harness` generates synthetic workflows and
  persists results to `load_benchmarks`; no published throughput baselines.
- **Telemetry granularity.** Aggregates roll up at one-minute resolution;
  sub-minute spikes visible only in raw `workflow_events`.

## Runtime credibility sprint — verification status

- **Security audit.** Vite/esbuild audit findings were cleared by upgrading the
  frontend toolchain to Vite 8 and refreshing the lockfile.
- **Runtime verification.** Vitest now covers workflow enqueue behavior, worker
  downstream scheduling and finalization, retry/backoff policy, approval
  pause/resume control flow, replay checkpoint resume behavior, pinned-version
  resolution across runtime entrypoints, and runtime validation reporting
  through local fixtures and Supabase-style stubs.
- **CI / release gating.** GitHub Actions now re-run `npm run lint`, `npm test`,
  `npm run test:runtime`, and `npm run build` on every pull request and push to
  `main`, alongside `npm audit`, repository secret scanning, and CodeQL.
- **Local validation.** `npm run lint`, `npm test`, `npm run test:runtime`, and
  `npm run build` pass locally after the tenant isolation hardening updates.
- **Tenant isolation hardening.** Workflow execution now requires an authenticated
  tenant binding, runtime writes propagate `tenant_id`, worker inventory is
  admin-only, and operator-facing realtime feeds subscribe with tenant filters.
- **Pinned runtime execution.** Execute, trigger, worker, rollback, and replay
  paths now carry `workflow_version_id` when a published version exists and
  only fall back to legacy `workflow_dags` for compatibility when no versioned
  source is available.

## Edge / ops endpoint exposure

| Function | Classification | Notes |
|---|---|---|
| `webhook-ingress` | public ingress | Intentionally public; request authenticity comes from endpoint secret/signature validation and delivery idempotency. |
| `execute-workflow`, `execute-api`, `generate-workflow`, `replay-workflow` | authenticated user/operator | Require JWT-verified callers; runtime writes still enforce tenant binding or downstream RLS where applicable. |
| `manual-launch`, `approval-decision`, `control-plane`, `platform-control`, `workflow-publish`, `scheduler-tick`, `runtime-validate`, `scale-monitor`, `tick-connectors`, `load-harness`, `rollback-executor` | authenticated user/operator | JWT required; operator/admin checks remain in function logic for control-plane and ops mutations, and scheduler/runtime inspection now reject non-operator tenant users. |
| `run-worker`, `sla-sweeper`, `event-trigger-router` | internal service/cron | JWT required plus internal bearer validation (`SUPABASE_SERVICE_ROLE_KEY` or `VALTARIS_INTERNAL_TOKEN`) before any service-role work starts. |
| `worker-health`, `otel-export` | admin-only | JWT required; only tenant admins or trusted internal callers may access worker inventory, shutdown controls, or raw telemetry export. |

## Remaining security assumptions

- Internal cron and worker-to-worker calls must present a trusted bearer token.
  `SUPABASE_SERVICE_ROLE_KEY` remains the default internal credential; optional
  `VALTARIS_INTERNAL_TOKEN` can be used as a dedicated internal bearer.
- Service-role clients are still required for queue mutation, sweeper recovery,
  worker inventory, and global telemetry export because those paths cross tenant
  boundaries or must bypass RLS for runtime-internal writes.
- Public webhook ingress remains the only endpoint with `verify_jwt = false`;
  its protection model is shared-secret signature validation plus delivery
  deduplication, not session auth.

## PLANNED — designed, not yet started

- Replay re-execution mode (currently observational only) with
  idempotency-key enforcement across all connectors.
- Per-tenant rate limiting at `claim_next_job`.
- Enforced multi-region job routing with cross-region replication SLAs.
- Long-lived worker process deployment with edge functions reserved for
  the control plane.
- Published throughput baselines and an SLO catalog.
- Expanded first-class connector coverage (HubSpot, Notion, GitHub, custom HTTP).
- Visual rollback path inspector (currently surfaced only via raw events).

## Non-goals (for now)

- Acting as a managed message broker.
- Competing on raw throughput with Temporal / Inngest at multi-region scale.
- Built-in code execution / arbitrary scripting inside workflow nodes.
