# Valtaris Glue

> Enterprise-grade workflow orchestration runtime that helps teams execute governed, replayable, telemetry-native automations across connectors and approvals.

---

## Table of Contents

* Overview
* Why This Exists
* Enterprise Highlights
* Key Features
* Architecture
* Technology Stack
* Project Structure
* Core Workflows
* Security
* Database Design
* API Overview
* Installation
* Configuration
* Testing
* Deployment
* Performance
* Roadmap
* Documentation
* Screenshots
* Contributing
* License
* Author
* Acknowledgements

---

# Overview

Valtaris Glue is a durable workflow orchestration platform for teams that need to run operational automations with governance, auditability, and deterministic replay. It combines a React operator console, Supabase-backed runtime services, queue-driven workers, approval gates, and telemetry pipelines so operators can launch, monitor, recover, and analyze workflow executions across tenants and connectors.

---

# Why This Exists

## Business Problem

Modern operations teams need to automate cross-system processes, but many internal workflows still rely on brittle scripts, manual handoffs, and disconnected SaaS integrations that are hard to observe, govern, or recover after failure.

## Technical Challenge

Reliable orchestration requires durable job persistence, dependency-aware execution, retry and compensation handling, approval routing, tenant isolation, and end-to-end telemetry without disrupting in-flight runs when workflows evolve.

## Solution

Valtaris Glue addresses these challenges with a pinned-version DAG execution model, leased queue workers, approval and rollback flows, connector adapters, telemetry aggregation, and an operator-facing control plane built for operational visibility and governed automation.

---

# Enterprise Highlights

* Enterprise-grade architecture
* Multi-tenant design
* Secure authentication
* Role-based access control (RBAC)
* Row-Level Security (RLS)
* Audit logging
* Durable workflow execution
* Retry and recovery mechanisms
* Queue-based processing
* Event-driven architecture
* AI-assisted automation
* RESTful APIs
* Real-time dashboards
* Structured observability
* Production-ready infrastructure
* Scalable cloud deployment
* SOC 2 aligned security practices
* HIPAA-ready architecture (where applicable)

---

# Key Features

## Core Capabilities

* Durable, queue-backed workflow execution with leases, retries, and dead-letter handling
* Pinned workflow versioning so published updates do not disrupt in-flight runs
* DAG-based orchestration with parallel fan-out, branch handling, approvals, and compensation
* Real-time operator console for command, inspection, and incident visibility
* Deterministic observational replay from checkpoints and event history

## Administrative Features

* Tenant-scoped governance policies and approval workflows
* Workflow publishing validation, template installation, and deployment validation
* Worker lifecycle controls including health, draining, and stale job recovery

## Automation

* Webhook, scheduler, and event-trigger ingress for runtime execution
* Connector adapter model for external services including Stripe, OpenAI, and SendGrid
* Automated rollback execution and SLA breach detection via background functions

## Reporting

* Runtime telemetry stream with realtime dashboard updates
* Aggregate metrics for throughput, latency, and queue pressure
* Incident, audit, and event history for operational review and replay analysis

---

# Architecture

## High-Level Architecture

> See the runtime architecture in `docs/runtime/deployment-topology.md` and the repository docs for deeper system diagrams.

---

## System Components

### Frontend

React and TypeScript operator console for Command Center, Workflow Studio, Runtime Inspector, platform controls, and runtime documentation.

### Backend

Supabase Edge Functions implement workflow execution, worker runtime control, approvals, replay, rollback, scheduling, ingress, scaling checks, and platform operations.

### Database

PostgreSQL stores workflow definitions, versions, runs, jobs, step results, approvals, incidents, audit records, checkpoints, and telemetry data.

### Authentication

JWT-based access with tenant-aware authorization and role checks enforced along operational paths.

### Storage

Operational state, runtime logs, telemetry aggregates, templates, and workflow metadata are persisted in Supabase/PostgreSQL-backed services.

### AI Services

AI-capable connectors and governance traces support model-driven decisions with confidence-based escalation and audit lineage.

### Background Workers

Queue workers claim jobs with `FOR UPDATE SKIP LOCKED`, execute connector actions, renew leases, emit telemetry, and drive retries or compensation.

### Integrations

Current first-class integrations include Stripe, OpenAI, and SendGrid, with mock-capable adapters for additional services such as Slack, Twilio, and Salesforce.

---

## Data Flow

An operator or external trigger starts a published workflow version, which is expanded into durable jobs in PostgreSQL. Workers claim eligible jobs from the queue, execute connector steps, persist step results and checkpoints, emit workflow events and telemetry, then unlock dependent jobs or route failures into retry, approval, rollback, incident, or dead-letter paths. The operator console subscribes to realtime updates for monitoring and intervention.

---

# Technology Stack

## Frontend

* React
* TypeScript
* Vite
* Tailwind CSS

## Backend

* Supabase
* PostgreSQL
* Edge Functions

## Infrastructure

* Cloud-hosted Supabase/Lovable runtime
* Database-backed durable queueing
* Supabase authentication and realtime services

## AI

* OpenAI
* Connector-based AI decision flows
* Governance-aware AI decision tracing

## DevOps

* GitHub
* CI/CD-ready project structure
* Runtime telemetry and tracing
* Operational logging and incident visibility

---

# Project Structure

```text
project/
│
├── src/
│   ├── components/
│   ├── pages/
│   ├── store/
│   └── runtime/
├── docs/
│   ├── runtime/
│   ├── platform/
│   └── STATUS.md
├── public/
├── supabase/
│   ├── functions/
│   └── migrations/
├── .env.example
├── CHANGELOG.md
├── README.md
├── bun.lock
├── package.json
├── playwright.config.ts
├── tailwind.config.ts
├── vite.config.ts
└── vitest.config.ts
```

---

# Core Workflows

## Workflow One

Purpose

Execute published workflows durably across dependent steps.

Process

`execute-workflow` pins a workflow version, expands the DAG into `workflow_jobs`, and workers claim ready jobs until the workflow completes.

Expected Result

Reliable end-to-end workflow execution with parallelism, checkpointing, and recovery support.

---

## Workflow Two

Purpose

Apply governance to automation steps that require human review or confidence thresholds.

Process

The worker records decision metadata, compares policy thresholds, and either continues automatically, queues an approval, or fails and rolls back the run.

Expected Result

Sensitive or low-confidence automation decisions are gated with auditability and operator intervention.

---

## Workflow Three

Purpose

Observe, investigate, and recover workflow activity in production.

Process

Telemetry events, aggregates, checkpoints, incidents, and runtime controls feed the operator console, replay tools, and rollback mechanisms.

Expected Result

Operators can diagnose failures, replay timelines, monitor queue pressure, and restore workflow health quickly.

---

# Security

## Authentication

The platform relies on Supabase/JWT-based authentication for operator and API access.

## Authorization

Tenant-scoped access is enforced with role checks and Row-Level Security across operational data paths.

## Data Protection

Frontend environment variables are limited to public Supabase configuration while backend secrets remain server-side; connector secrets are never exposed to the client.

## Audit Logging

Workflow approvals, operator actions, AI decision traces, runtime events, and security-related actions are recorded in append-only or audit-oriented tables.

## Input Validation

Workflow publishing and runtime operations include deployment and execution validation, while connector execution paths classify errors and constrain runtime behavior.

## Error Handling

Failures are classified into retryable or terminal outcomes, routed through exponential backoff, incident creation, dead-letter handling, and optional compensation.

## Compliance

The architecture is designed around enterprise governance, auditability, tenant isolation, and security practices aligned with regulated operational environments.

---

# Database Design

## Overview

The database acts as the workflow system of record, durable queue, event log, and telemetry store for all orchestration and governance activity.

## Core Tables

* `workflow_runs`
* `workflow_jobs`
* `workflow_step_runs`
* `workflow_checkpoints`
* `workflow_events`
* `workflow_approvals`
* `workflow_incidents`

## Relationships

Workflow runs are pinned to a workflow version and own many jobs, step runs, checkpoints, events, approvals, and incidents. Jobs map to DAG nodes and unlock downstream jobs when dependency conditions are satisfied.

## Indexing Strategy

The queue design depends on efficient claim and scheduling paths, including partition-aware job selection and lease-based polling optimized for worker claims and retry windows.

---

# API Overview

## Authentication

Authenticated access is required for operator and control-plane actions.

## Primary Endpoints

| Endpoint | Purpose |
| -------- | ------- |
| `execute-workflow` | Expands and starts a published workflow run |
| `run-worker` | Claims and executes queued jobs |
| `approval-decision` | Approves or rejects gated steps |
| `rollback-executor` | Runs compensation for failed or rolled back workflows |
| `replay-workflow` | Reconstructs workflow execution from checkpoints |
| `webhook-ingress` | Starts workflows from external webhooks |
| `scheduler-tick` | Triggers scheduled workflows |
| `scale-monitor` | Reports queue pressure and scaling signals |

## Response Format

The platform uses structured payloads through Supabase Edge Functions and runtime tables, with workflow state, event, and telemetry data surfaced to the UI and operational tooling.

---

# Installation

## Prerequisites

* Bun
* Access to a Supabase project or Lovable Cloud runtime

## Clone Repository

```bash
git clone <repository-url>
```

## Install Dependencies

```bash
bun install
```

## Configure Environment

Create a `.env` file and add the required environment variables.

## Start Development Server

```bash
bun run dev
```

---

# Configuration

Required client-side environment variables are documented in `.env.example`, including `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_SUPABASE_PROJECT_ID`. Backend integrations such as Stripe, OpenAI, SendGrid, Slack, Twilio, and Salesforce are configured as server-side secrets; missing secrets fall back to mock-mode responses for supported adapters.

---

# Testing

## Unit Tests

Vitest is configured for frontend and runtime test coverage.

## Integration Tests

Runtime behavior is validated through Supabase functions, execution flows, and connector pathways documented in the runtime modules.

## Manual Testing

Use the operator console, runtime validation endpoints, and workflow scenarios to verify execution, approvals, replay, and incident handling.

## Performance Testing

The `load-harness` runtime function generates synthetic workloads for throughput and queue behavior analysis, though published baselines are still pending.

---

# Deployment

## Development

Run the Vite development server locally with configured Supabase access.

## Staging

Deploy Supabase functions, schema migrations, and the frontend against a non-production Supabase project for end-to-end validation.

## Production

Run the platform in a cloud-hosted Supabase-backed environment with durable runtime functions, monitored queue workers, and production secrets configured server-side.

---

# Performance

## Optimization

The runtime uses dependency-aware job scheduling, version pinning, and centralized retry classification to keep execution predictable under load.

## Caching

Operational efficiency relies primarily on durable persistence and realtime subscriptions rather than aggressive application-side caching.

## Background Processing

Workers, cron-driven sweepers, replay services, rollback handlers, and scaling monitors process runtime activity asynchronously.

## Scalability

Horizontal worker scaling, partition-aware queueing, lease recovery, and pressure monitoring support increased concurrency, while multi-region enforcement remains a planned enhancement.

---

# Roadmap

## Current Release

Durable queue execution, pinned-version workflows, replay, approvals, rollback, telemetry, connector adapters, templates, and operator tooling are implemented.

## Next Release

Long-lived worker hosting, published load baselines, broader connector coverage, and stronger regional execution controls are planned next.

## Future Vision

Valtaris Glue aims to evolve into a more scalable, governed orchestration platform with richer connector ecosystems, stronger replay semantics, and deeper enterprise operations controls.

---

# Documentation

| Document | Description |
| -------- | ----------- |
| Runtime Docs | Engine internals for orchestration, workers, replay, telemetry, and governance |
| Platform Docs | Templates, marketplace, deployment, onboarding, and replay guidance |
| STATUS.md | Real versus partial versus planned capability matrix |
| CHANGELOG.md | Delivery history and phase evolution |

---

# Screenshots

> Add screenshots, diagrams, dashboards, or workflow illustrations.

---

# Contributing

Follow existing repository conventions for TypeScript, React, Supabase functions, and runtime documentation. Keep changes scoped, validate with the existing `bun run lint`, `bun run test`, and `bun run build` scripts where applicable, and use pull requests for reviewable changes.

---

# License

No explicit license file is currently present in the repository; define the project license before external distribution.

---

# Author

**George Rios**

Founder & Software Engineer

**Valtaris Technologies**

---

# Acknowledgements

Built with React, Vite, Tailwind CSS, Supabase, PostgreSQL, Vitest, Playwright, and the connector and observability patterns documented throughout the project.
