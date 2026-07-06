# Changelog

All notable phases of Valtaris Glue, in delivery order. Dates are
phase-relative; see git history for exact timestamps.

## Phase — Runtime Execution

- Durable `workflow_jobs` queue with `claim_next_job` (`FOR UPDATE SKIP LOCKED`).
- `run-worker` edge function: lease, execute, checkpoint, emit events.
- Centralized retry policy with classified errors (`timeout | auth | rate_limit | server | client`).
- `_shared/dag.ts` DAG executor with parallel fan-out and branch nodes.
- `workflow_checkpoints` + `workflow_events` for observational replay.
- `sla-sweeper`, `rollback-executor`, `approval-decision` control-plane functions.
- Connector adapters: Stripe, OpenAI, SendGrid (real); Slack, Twilio, Salesforce (mock-default).

## Phase — Tenant Security + Operator Identity

- `tenant_id` and tenant-scoped RLS across all operational tables.
- `tenant_members` + `has_role` SECURITY DEFINER function for runtime authorization.
- Authenticated operator identity threaded through `approval-decision`,
  `control-plane`, and `replay-workflow`.
- Append-only `security_events` audit trail; `SecurityEventsFeed` UI.
- Replay safety: approval decisions reused via `decision_id` to prevent
  silent privilege escalation on replay.

## Phase — Triggering Surface

- `webhook-ingress`, `scheduler-tick`, `event-trigger-router` edge functions.
- `manual-launch` for operator-initiated runs with tenant + role checks.
- `_shared/triggers.ts` for shared ingress validation, signing, dedupe.
- `ActivationPanel` operator UI; `useActivation` store.
- Pinned-version dispatch so external triggers never race with publishes.

## Phase — Workflow Studio + Versioning

- `workflow_versions` (draft / published / archived / deprecated) with
  immutability triggers on published graphs.
- `workflow-publish` with `validate_workflow_version`: cycle detection,
  orphan / unreachable analysis, connector schema validation, approver presence.
- `DAGEditor`, `WorkflowStudio` page, `useWorkflowStudio` store.
- `WorkflowHealthPanel`: pre-publish numeric health score.
- Runtime reads topology from pinned `workflow_version_id`, never from latest draft.

## Phase — Production Runtime Scale

- Runtime entrypoints now resolve immutable `workflow_versions` before
  enqueueing work and only fall back to legacy `workflow_dags` when no
  published version exists.
- `execute-workflow`, trigger ingress, `run-worker`, rollback execution, and
  replay metadata now preserve pinned `workflow_version_id` across runtime
  lifecycle records.
- Added runtime coverage for published-version pinning after studio edits,
  rollback version selection, replay version preservation, and legacy DAG
  compatibility.

- Worker lifecycle: `renew_job_lease`, `worker_shutdown`, `worker-health` probe.
- Scaling signals: `scaling_metrics`, `queue_pressure_signals`,
  `worker_capacity_snapshots`, `capture_queue_pressure` RPC.
- `trace_spans` + `_shared/tracing.ts`; OTLP export via `otel-export`.
- Connector circuit breakers (`closed → open → half_open`) integrated into `run-worker`.
- `load-harness` for synthetic throughput benchmarking.
- `ScaleInfrastructurePanel` operational dashboard.
- `docs/runtime/` deployment-topology, scaling-architecture, observability-stack.

## Phase — Platform Refinement + Productization

- `workflow_templates`, `template_versions`, `template_installs` for reusable workflows.
- `connector_catalog` + `connector_capabilities` marketplace.
- `platform-control` edge function: `install_template`, `export_pack`, `validate_deployment`.
- `deployment_profiles`, `environment_configs`, `deployment_validations`.
- `onboarding_progress`, `operator_bookmarks`, `saved_dashboards`.
- `/platform`, `/quickstart`, `/docs`, `/inspector` operator pages.
- Rebrand to **Valtaris Glue**; nav reorganized into Get Started / Build / Orchestrate / Observe.
- `WorkflowHealthPanel`, `RuntimeInspector` forensic tooling.
