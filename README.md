# Valtaris Glue

**Telemetry-native workflow orchestration runtime.**

Valtaris Glue is a durable, replayable, governance-aware workflow execution
engine. It persists every step of a multi-connector workflow, drives execution
through a queue of leased jobs processed by horizontally scalable workers,
and emits a telemetry stream that can be replayed deterministically from
checkpoints.

This README describes the system honestly — what is real, what is partial,
and what is planned. It is not marketing copy.

---

## What Valtaris Glue Is

- A backend-driven orchestration runtime with a React operator console.
- A pinned-version DAG executor: every run is bound to an immutable
  `workflow_version_id` so in-flight runs survive new publishes.
- A telemetry surface: `workflow_events`, `telemetry_aggregates`, distributed
  `trace_spans`, and an OTLP-compatible export endpoint.
- A governance layer: approval gates, signed operator decisions, tenant-scoped
  RLS, and an append-only `security_events` audit trail.
- A platform: workflow templates, a connector catalog with capability metadata,
  deployment validation, and onboarding tracking.

It is **not** a managed message broker, not a Temporal/Inngest replacement at
scale, and not (yet) a multi-region cluster. It is a single-cluster execution
engine with the right primitives in place.

---

## Runtime Architecture

```text
                   ┌─────────────────────┐
   operator UI ───►│  execute-workflow   │── enqueues root jobs
                   └──────────┬──────────┘
                              │
                   ┌──────────▼──────────┐
                   │   workflow_jobs     │  durable queue
                   │ (FOR UPDATE SKIP    │  partitioned, leased,
                   │  LOCKED claims)     │  priority-classed
                   └──────────┬──────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────▼─────┐          ┌────▼─────┐          ┌────▼─────┐
   │ worker A │          │ worker B │          │ worker C │   run-worker
   └────┬─────┘          └────┬─────┘          └────┬─────┘
        │                     │                     │
        └────────────┬────────┴────────┬────────────┘
                     ▼                 ▼
              connector adapter   checkpoint + event
                                  emission
```

Supporting control plane:

```text
sla-sweeper       → detect_sla_breaches, sweep_stale_jobs
control-plane     → drain_worker, pause/resume partition, reconcile_orphans
rollback-executor → walks checkpoints in reverse, runs compensation
approval-decision → resume_after_approval / reject_approval
replay-workflow   → reconstructs a run from workflow_checkpoints
scale-monitor     → capture_queue_pressure, scaling recommendations
platform-control  → template install, export pack, deployment validation
```

---

## Execution Flow

1. `execute-workflow` receives a published DAG, creates a `workflow_runs` row
   pinned to a `workflow_version_id`, and expands the DAG into
   `workflow_jobs` honoring `dependsOn`.
2. `run-worker` calls `claim_next_job(worker_id)` — a `SECURITY DEFINER`
   function that selects the next eligible job with
   `FOR UPDATE OF j SKIP LOCKED`, honoring partition pause/concurrency caps.
3. The worker resolves the node's connector adapter, enforces a per-call
   timeout, classifies errors, and writes a `workflow_step_runs` row plus a
   `workflow_checkpoints` snapshot.
4. Connector outcomes feed `record_connector_result`, which drives a circuit
   breaker (`closed → open → half_open`) per connector.
5. On retryable failure, the centralized retry policy schedules exponential
   backoff with full jitter; on terminal failure the job moves to
   `workflow_dead_letter` and a `workflow_incidents` row is opened.
6. When all sink nodes complete, the run transitions to `completed`.
7. `sla-sweeper` runs on a per-minute cron to detect breaches and reclaim
   stale leases via `sweep_stale_jobs`.

---

## Core Features

- **Durable queue** with partitions, leases, dead-letter, and pressure signals.
- **Pinned-version execution** so publishes never disturb in-flight runs.
- **Observational replay** from `workflow_checkpoints` joined with
  `workflow_events`.
- **Approval gates** with signed operator decisions and audit trail.
- **Rollback / compensation** by reverse-walking checkpoints.
- **Circuit breakers** per connector with half-open probing.
- **Distributed tracing** via `trace_spans` and OTLP export.
- **Workflow Studio** with cycle / orphan / unreachable detection.
- **Runtime Inspector** — timeline, event log, checkpoint replay, diffing.
- **Platform** — workflow templates, connector catalog, deployment validation.
- **Webhook / scheduler / event ingress** for externally-triggered workflows.

---

## What Is Real Today

| Subsystem               | Status | Notes                                                  |
| ----------------------- | ------ | ------------------------------------------------------ |
| Durable job queue       | Real   | `claim_next_job`, partitions, leases, DLQ              |
| Worker runtime          | Real   | Registry, heartbeats, draining, lease renewal          |
| DAG executor            | Real   | Parallel fan-out, branch, approval, rollback nodes     |
| Retry / backoff         | Real   | Classified errors, jittered exponential backoff        |
| Checkpoints + replay    | Real   | Observational replay from pinned versions              |
| Telemetry stream        | Real   | `workflow_events` + realtime channels                  |
| Telemetry rollups       | Real   | `aggregate_telemetry`, cron-scheduled                  |
| SLA breach detection    | Real   | Opens incidents, surfaces in IncidentFeed              |
| Approvals               | Real   | Tenant-scoped, signed, replay-safe via decision_id     |
| Rollback / compensation | Real   | Reverse-walk over checkpoints                          |
| Circuit breakers        | Real   | Per-connector state machine, half-open probing         |
| Tenant isolation        | Real   | `tenant_id` + RLS + `has_role` on all operational paths|
| Workflow versioning     | Real   | Draft → published → archived; publish-gate validation  |
| External triggering     | Real   | Webhook, scheduler, event-router edge functions        |
| Platform / templates    | Real   | Catalog, install, export pack, deployment validation   |
| Distributed tracing     | Real   | `trace_spans` + OTLP-compatible export                 |

---

## What Is Partial

| Subsystem              | Status  | Gap                                                  |
| ---------------------- | ------- | ---------------------------------------------------- |
| Connector adapters     | Partial | Stripe / OpenAI / SendGrid real; others mock-default |
| Multi-region routing   | Partial | `region` columns present; routing not enforced       |
| Worker host model      | Partial | Edge-function workers; long-lived host not yet wired |
| Load test harness      | Partial | `load-harness` exists; published baselines pending   |
| Aggregate granularity  | Partial | One-minute rollups; sub-minute only via raw events   |

See `docs/STATUS.md` for the full REAL / PARTIAL / PLANNED matrix.

---

## Roadmap

1. Long-lived worker process (Fly Machine / Cloud Run) with edge functions
   reserved for the control plane.
2. Replay re-execution mode with idempotency-key enforcement (currently
   observational only).
3. Per-tenant rate limiting at `claim_next_job`.
4. Enforced multi-region job routing.
5. Published throughput baselines from the load harness.
6. Expanded connector coverage beyond Stripe / OpenAI / SendGrid.

---

## Local Setup

Prerequisites: Bun, a Supabase project (or Lovable Cloud), the keys below.

```bash
bun install
cp .env.example .env   # fill in real values
bun run dev
```

Required env vars (see `.env.example`):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_PROJECT_ID`

Backend secrets (Stripe, OpenAI, SendGrid, Slack, Twilio, Salesforce) are
configured on the backend; the frontend never sees them. Missing secrets
trigger mock-mode adapter responses so the runtime stays exercisable.

---

## Validation / Testing

```bash
npm run lint          # eslint
npm test              # vitest suite
npm run test:runtime  # runtime-focused vitest suite
npm run build         # vite production build
```

Automated release gating runs the same validation on every `pull_request` and
every push to `main`, then adds:

- `npm audit --audit-level=high`
- repository secret scanning
- CodeQL analysis for JavaScript/TypeScript

The validation workflow retains test-result artifacts, coverage output, and
build logs for failure triage. See
`/home/runner/work/valtaris-glue/valtaris-glue/docs/platform/release-validation.md`
for the required checks, failure-handling flow, and branch-protection
assumptions.

Runtime validation endpoints:

- `runtime-validate` — consistency checks across runs, checkpoints, jobs.
- `worker-health` — worker liveness probe.
- `scale-monitor` — queue-pressure recommendations.
- `load-harness` — synthetic throughput harness.

---

## Screenshots

> Placeholder paths. Add images under `docs/screenshots/` and link them here.

- **Command Center** — `docs/screenshots/command-center.png`
- **Runtime Inspector** — `docs/screenshots/runtime-inspector.png`
- **Workflow Studio** — `docs/screenshots/workflow-studio.png`
- **Quickstart** — `docs/screenshots/quickstart.png`
- **Docs** — `docs/screenshots/docs.png`

---

## Repository Layout

```text
src/
  components/mission/   Operator console (real-time runtime views)
  components/shell/     App shell, navigation
  runtime/              Client-side runtime helpers (typed)
  store/                Zustand stores hydrated from Supabase + realtime
  pages/                Routes
supabase/
  functions/
    _shared/            connectors, retry, dag, auth, triggers, tracing
    execute-workflow/   DAG → workflow_jobs expansion
    run-worker/         Queue drainer
    sla-sweeper/        Cron: detect breaches, reclaim stale leases
    control-plane/      Operator RPCs
    rollback-executor/  Compensation runner
    approval-decision/  Approval resume/reject
    replay-workflow/    Checkpoint reconstruction
    webhook-ingress/    External webhook triggers
    scheduler-tick/     Time-based triggers
    event-trigger-router/ Event-driven triggers
    workflow-publish/   Version validation + publish
    scale-monitor/      Queue pressure + scaling recommendations
    otel-export/        OTLP-compatible trace export
    platform-control/   Templates, packs, deployment validation
  migrations/           SQL schema + functions
docs/
  runtime/              Per-engine deep-dive docs
  platform/             Platform / productization docs
  STATUS.md             REAL / PARTIAL / PLANNED matrix
```

See `docs/runtime/` and `docs/platform/` for deep dives, and `CHANGELOG.md`
for the phase-by-phase delivery history.
