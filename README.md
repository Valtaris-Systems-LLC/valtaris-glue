# Valtaris Glue

> Governed workflow orchestration runtime for durable, replayable, observable automations across connectors, approvals, and operational workflows.

---

## Table of Contents

- Overview
- Why This Exists
- System Capabilities
- Key Features
- Architecture
- Technology Stack
- Project Structure
- Core Workflows
- Security
- Database Design
- API Overview
- Installation
- Configuration
- Testing
- Deployment
- Performance
- Capability Status
- Roadmap
- Documentation
- Screenshots
- Contributing
- License
- Author
- Acknowledgements

---

# Overview

Valtaris Glue is a workflow orchestration platform designed for teams that need to execute operational automations with durable state, governance, auditability, replay, and runtime visibility.

The system combines a React operator console, Supabase-backed runtime services, PostgreSQL persistence, queue-driven workers, approval gates, connector adapters, and telemetry pipelines.

The platform is designed around a simple principle:

**Workflow execution should remain observable, recoverable, and explainable even when individual steps fail or workflows evolve.**

Valtaris Glue is an independent engineering project and research implementation. It is not represented as a commercially deployed enterprise platform, independently certified compliance system, or production-scale service.

---

# Why This Exists

## Business Problem

Operational teams frequently automate cross-system processes using scripts, manual handoffs, scheduled jobs, and disconnected SaaS integrations.

These approaches can become difficult to:

- observe;
- recover;
- audit;
- govern;
- replay;
- modify safely;
- operate across multiple tenants.

## Technical Challenge

Reliable orchestration requires more than simply calling APIs.

A workflow runtime must account for:

- durable job persistence;
- dependency-aware execution;
- retries;
- leases;
- failure recovery;
- compensation;
- approvals;
- tenant boundaries;
- versioning;
- telemetry;
- operator intervention.

A workflow update also needs to avoid unexpectedly changing the behavior of executions that are already in progress.

## Solution

Valtaris Glue addresses these problems through:

- pinned workflow versions;
- DAG-based execution;
- durable queue-backed jobs;
- leased workers;
- retry and dead-letter handling;
- approval routing;
- compensation and rollback;
- connector adapters;
- runtime telemetry;
- replay capabilities;
- operator-facing controls.

---

# System Capabilities

Valtaris Glue currently includes the following system areas:

| Capability | Current Position |
| --- | --- |
| Durable workflow execution | Implemented |
| Queue-backed workers | Implemented |
| Workflow version pinning | Implemented |
| DAG execution | Implemented |
| Parallel workflow branches | Implemented |
| Approval workflows | Implemented |
| Retry handling | Implemented |
| Dead-letter handling | Implemented |
| Compensation / rollback | Implemented |
| Runtime telemetry | Implemented |
| Operator console | Implemented |
| Workflow replay | Implemented |
| Connector adapters | Implemented |
| Scheduled execution | Implemented |
| Webhook ingress | Implemented |
| Tenant-aware authorization | Implemented |
| PostgreSQL RLS | Implemented |
| AI connector support | Implemented |
| Formal production-scale benchmarks | Not yet established |
| Multi-region execution | Roadmap |
| Long-lived worker hosting | Roadmap |
| Independent security/compliance certification | Not claimed |

---

# Key Features

## Durable Workflow Execution

Workflow execution is represented as persisted runtime state rather than depending entirely on an active browser session.

Jobs can be:

- queued;
- claimed;
- executed;
- retried;
- completed;
- failed;
- dead-lettered.

Workers use leases to reduce the risk of abandoned work remaining indefinitely in an active state.

---

## Pinned Workflow Versions

Published workflows are versioned before execution.

A workflow run references a specific workflow version so that changes to a later published version do not unexpectedly modify the definition being executed by an existing run.

Conceptually:

```text
Workflow
   │
   ├── Version 1
   ├── Version 2
   └── Version 3
          │
          ▼
     Workflow Run
          │
          ▼
     Pinned Version
```

This provides a stable execution boundary for individual workflow runs.

---

## DAG-Based Orchestration

Workflows are represented as directed acyclic graphs.

The runtime can evaluate:

- dependencies;
- parallel branches;
- downstream unlock conditions;
- branch outcomes;
- approval gates;
- failure paths;
- compensation paths.

Example:

```text
             ┌── Step B ──┐
Step A ──────┤            ├──── Step D
             └── Step C ──┘
```

Step D does not become eligible until its required dependencies are satisfied.

---

## Approvals and Governance

Certain workflow steps can require human approval before execution continues.

The runtime can route execution into an approval state based on configured workflow conditions.

This allows a workflow to combine:

```text
Automation
    ↓
Decision
    ↓
Policy Check
    ↓
┌───────────────┐
│               │
▼               ▼
Approved      Rejected
│               │
▼               ▼
Continue      Rollback /
              Failure
```

Approval actions are persisted for later operational review.

---

## Replay

Valtaris Glue maintains execution history and checkpoints that can be used to reconstruct workflow activity.

Replay is designed as an observational and diagnostic capability rather than an unrestricted mechanism for blindly re-running side effects.

This distinction is important when workflows interact with external systems.

---

## Connector Model

The runtime uses connector adapters to isolate external service integrations from orchestration logic.

Current connector work includes integrations such as:

- Stripe;
- OpenAI;
- SendGrid.

Mock-capable adapters also support additional development scenarios such as:

- Slack;
- Twilio;
- Salesforce.

Connector execution is represented as part of workflow runtime state and telemetry.

---

## Runtime Telemetry

Workflow execution produces operational events and telemetry used by the operator console.

Telemetry can be used to inspect:

- workflow activity;
- job execution;
- step timing;
- failures;
- retries;
- queue pressure;
- incidents;
- connector activity.

The goal is to make workflow behavior observable rather than treating execution as a black box.

---

# Architecture

## High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                     React Operator Console                  │
│                                                             │
│ Command Center · Workflow Studio · Runtime Inspector        │
│ Approvals · Incidents · Platform Controls · Telemetry       │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ Supabase Client / Auth
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Supabase Platform                       │
│                                                             │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │ PostgreSQL     │  │ Edge Functions   │  │ Storage      │ │
│  │                │  │                  │  │              │ │
│  │ Workflow State │  │ Workflow Engine  │  │ Runtime Data │ │
│  │ Jobs           │  │ Workers          │  │ Templates    │ │
│  │ Events         │  │ Replay           │  │ Metadata     │ │
│  │ RLS            │  │ Rollback         │  │              │ │
│  │ Audit Data     │  │ Scheduling       │  │              │ │
│  └────────────────┘  └──────────────────┘  └──────────────┘ │
│                                                             │
│                       Supabase Auth                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Connector Layer                         │
│                                                             │
│ Stripe · OpenAI · SendGrid · Mock Adapters                  │
└─────────────────────────────────────────────────────────────┘
```

---

## System Components

### Frontend

React and TypeScript operator console providing interfaces for:

- Command Center;
- Workflow Studio;
- Runtime Inspector;
- approvals;
- incidents;
- platform controls;
- telemetry;
- runtime documentation.

### Backend

Supabase Edge Functions implement workflow execution, worker control, approvals, replay, rollback, scheduling, ingress, and runtime operations.

### Database

PostgreSQL stores:

- workflow definitions;
- workflow versions;
- runs;
- jobs;
- step results;
- approvals;
- incidents;
- checkpoints;
- events;
- telemetry.

### Authentication

Supabase Auth provides authenticated identity and JWT-based access.

Database authorization uses authenticated identity and organization context rather than relying solely on browser-provided tenant identifiers.

### Background Workers

Queue workers claim jobs using transactional database operations, execute eligible workflow steps, renew leases where applicable, persist results, emit telemetry, and route failures through retry or recovery paths.

### Integrations

Connector adapters isolate external service calls from the core orchestration model.

---

# Data Flow

A workflow can begin through an operator action, scheduler, or external webhook.

The general execution path is:

```text
Trigger
   ↓
Published Workflow
   ↓
Pinned Workflow Version
   ↓
Workflow Run
   ↓
DAG Expansion
   ↓
Durable Jobs
   ↓
Worker Claim
   ↓
Connector / Workflow Step
   ↓
Step Result
   ↓
Telemetry + Event
   ↓
Unlock Dependencies
   ↓
Continue / Retry / Approve / Rollback
   ↓
Workflow Completion
```

The operator console consumes persisted runtime information and realtime updates for monitoring and intervention.

---

# Technology Stack

## Frontend

- React
- TypeScript
- Vite
- Tailwind CSS

## Backend

- Supabase
- PostgreSQL
- Supabase Edge Functions
- Supabase Auth
- Supabase Realtime

## Infrastructure

- Database-backed durable queueing
- Lease-based worker execution
- Background functions
- Realtime runtime updates

## AI

- OpenAI connector
- AI-capable workflow steps
- Decision metadata and governance traces

AI functionality is treated as a connector/workflow capability rather than the core orchestration engine.

## Development

- Git
- GitHub
- Bun
- Vitest
- Playwright
- Supabase tooling

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
│
├── docs/
│   ├── runtime/
│   ├── platform/
│   └── STATUS.md
│
├── public/
│
├── supabase/
│   ├── functions/
│   └── migrations/
│
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

## Workflow One — Durable Execution

### Purpose

Execute published workflows across dependent steps while retaining durable runtime state.

### Process

`execute-workflow` identifies the published workflow version, creates a workflow run, expands the DAG into durable jobs, and workers claim eligible jobs.

### Expected Result

Workflow execution continues through persisted runtime state rather than depending exclusively on the operator's browser session.

---

## Workflow Two — Approval-Gated Execution

### Purpose

Require human intervention for workflow steps that should not execute automatically.

### Process

The runtime evaluates workflow conditions and can route execution into an approval state.

An operator can approve or reject the pending action.

### Expected Result

The workflow either continues through the approved path or enters its configured rejection/failure/recovery path.

---

## Workflow Three — Failure and Recovery

### Purpose

Handle workflow failures without losing runtime state.

### Process

```text
Step Failure
     ↓
Classify Failure
     ↓
Retryable?
   /       \
 Yes        No
  ↓          ↓
Retry      Failure
  ↓          ↓
Execute    Incident /
Again      Compensation
             ↓
          Recovery /
          Dead Letter
```

Retry behavior includes persisted job state and backoff handling.

---

## Workflow Four — Replay

### Purpose

Inspect the execution history of a workflow run.

### Process

The runtime uses stored workflow events, checkpoints, and step history to reconstruct execution state.

### Expected Result

Operators can inspect the sequence of workflow activity without depending solely on transient UI state.

---

## Workflow Five — External Ingress

Workflows can be initiated through supported external triggers such as:

- webhooks;
- schedules;
- operator actions.

Ingress is converted into a workflow execution request and processed through the same durable runtime model.

---

# Security

## Authentication

The platform uses Supabase Auth and JWT-based identity for authenticated operator and API access.

## Authorization

Tenant-aware authorization is implemented through:

- authenticated identity;
- organization membership;
- role checks;
- PostgreSQL RLS;
- backend authorization logic.

The system does not treat a client-supplied organization identifier as sufficient authorization.

---

## Row-Level Security

PostgreSQL RLS provides a database-level authorization boundary for organization-scoped records.

The intent is to ensure that authorization remains enforced even when application-level UI restrictions are bypassed.

---

## Data Protection

Client-side environment variables are limited to public configuration required by the browser.

Sensitive integration credentials are intended to remain server-side.

Service-role credentials must never be exposed through client-side `VITE_` variables.

---

## Audit Logging

Operational events can capture information such as:

- actor;
- organization;
- workflow;
- run;
- job;
- event type;
- timestamps;
- relevant metadata.

Audit and runtime event structures are used to support operational review and troubleshooting.

---

## Input Validation

Validation is performed at important workflow boundaries, including:

- workflow publishing;
- runtime execution;
- connector configuration;
- workflow state transitions.

The objective is to reject invalid workflow operations before they enter durable execution.

---

## Error Handling

Failures are classified according to runtime behavior.

Depending on the failure, the system can:

- retry;
- back off;
- create an incident;
- request approval;
- compensate;
- dead-letter the job.

---

## Compliance Position

Valtaris Glue includes architectural patterns relevant to systems that require:

- tenant isolation;
- access control;
- auditability;
- operational governance;
- durable execution.

However, the project does **not** claim:

- HIPAA certification;
- SOC 2 certification;
- independent security certification;
- legal compliance for a particular deployment;
- production authorization for regulated workloads.

Organizations deploying the system in regulated environments would need to perform their own security, privacy, compliance, legal, and operational assessments.

---

# Database Design

## Overview

PostgreSQL functions as the durable system of record for workflow definitions, execution state, jobs, checkpoints, approvals, incidents, and runtime events.

## Core Tables

Representative runtime domains include:

- `workflow_runs`
- `workflow_jobs`
- `workflow_step_runs`
- `workflow_checkpoints`
- `workflow_events`
- `workflow_approvals`
- `workflow_incidents`

Additional tables support:

- workflow definitions;
- workflow versions;
- connectors;
- templates;
- tenants;
- users;
- telemetry;
- operational configuration.

## Relationships

A workflow run references a specific workflow version.

The workflow run can own multiple jobs, step executions, checkpoints, events, approvals, and incidents.

Conceptually:

```text
Workflow
   ↓
Workflow Version
   ↓
Workflow Run
   ├── Jobs
   ├── Step Runs
   ├── Checkpoints
   ├── Events
   ├── Approvals
   └── Incidents
```

## Queue Design

Workers claim eligible jobs using transactional database operations.

The queue model incorporates:

- job state;
- leases;
- retry timing;
- dependency conditions;
- worker ownership;
- stale-job recovery.

`FOR UPDATE SKIP LOCKED` is used where appropriate to allow multiple workers to claim independent jobs without unnecessarily blocking one another.

---

# API Overview

## Authentication

Authenticated access is required for protected operator and runtime actions.

## Runtime Functions

Representative runtime functions include:

| Function | Purpose |
| --- | --- |
| `execute-workflow` | Creates and starts a workflow run |
| `run-worker` | Claims and executes queued jobs |
| `approval-decision` | Processes approval or rejection |
| `rollback-executor` | Executes compensation/rollback work |
| `replay-workflow` | Reconstructs workflow execution history |
| `webhook-ingress` | Starts workflows from external webhooks |
| `scheduler-tick` | Triggers scheduled workflows |
| `scale-monitor` | Reports queue pressure and runtime signals |

Exact function behavior and contracts are defined by the implementation in `supabase/functions/`.

---

# Installation

## Prerequisites

- Bun
- Access to a Supabase project or compatible hosted runtime

## Clone Repository

```bash
git clone <repository-url>
cd <repository-directory>
```

## Install Dependencies

```bash
bun install
```

## Configure Environment

Create a `.env` file using `.env.example` as the configuration reference.

## Start Development Server

```bash
bun run dev
```

---

# Configuration

Client-side configuration is documented in `.env.example`.

Representative variables include:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
VITE_SUPABASE_PROJECT_ID
```

Backend integrations such as:

- Stripe;
- OpenAI;
- SendGrid;
- Slack;
- Twilio;
- Salesforce;

should be configured through server-side secrets where required.

Mock-capable adapters may be used during development when live connector credentials are unavailable.

Sensitive credentials must not be committed to the repository.

---

# Testing

## Unit Tests

Vitest provides unit-level coverage for application and runtime behavior.

Run:

```bash
bun run test
```

## Linting

Run:

```bash
bun run lint
```

## Build

Run:

```bash
bun run build
```

## Browser Testing

Playwright configuration is included for browser-level validation where applicable.

## Integration Testing

Runtime behavior can be validated through:

- Supabase Edge Functions;
- workflow execution paths;
- connector adapters;
- approval flows;
- replay scenarios;
- failure/retry scenarios.

## Load Testing

The repository includes a `load-harness` runtime component for synthetic workload generation and queue behavior analysis.

Formal production-scale throughput and latency baselines have **not** been established and should not be inferred from the presence of the harness.

---

# Deployment

## Development

Run the Vite development server against a configured Supabase environment.

## Staging

A staging environment can be used to validate:

- schema migrations;
- Edge Functions;
- authentication;
- RLS;
- workflow execution;
- connector behavior;
- approvals;
- replay;
- failure recovery.

## Production

The architecture supports deployment to a hosted Supabase-backed environment.

However, this repository does **not** claim that the current project represents a commercially deployed production service.

Production deployment would require environment-specific:

- security validation;
- secrets management;
- monitoring;
- load testing;
- backup/recovery procedures;
- incident procedures;
- compliance assessment;
- operational ownership.

---

# Performance

## Current Architecture

The runtime includes several mechanisms intended to support efficient execution:

- database-backed queueing;
- dependency-aware job scheduling;
- worker leases;
- `FOR UPDATE SKIP LOCKED`;
- persisted workflow state;
- asynchronous background execution;
- realtime telemetry.

## Scaling

The architecture can support additional workers processing independent jobs concurrently.

Queue pressure and worker health can be monitored through runtime telemetry and operational controls.

## Current Limitation

Formal performance benchmarks have not yet established specific:

- requests per second;
- workflows per minute;
- job throughput;
- p95/p99 latency;
- maximum concurrent workers;
- multi-tenant load limits.

Accordingly, no production-scale performance number is claimed.

---

# Capability Status

Valtaris Glue intentionally separates implemented capabilities from capabilities that still require broader verification or development.

| Area | Status |
| --- | --- |
| Durable queue execution | Implemented |
| Workflow version pinning | Implemented |
| DAG execution | Implemented |
| Parallel branches | Implemented |
| Approval workflows | Implemented |
| Retry handling | Implemented |
| Dead-letter handling | Implemented |
| Compensation / rollback | Implemented |
| Runtime telemetry | Implemented |
| Operator console | Implemented |
| Replay functionality | Implemented |
| Scheduled workflows | Implemented |
| Webhook ingress | Implemented |
| Connector adapter model | Implemented |
| Stripe connector | Implemented |
| OpenAI connector | Implemented |
| SendGrid connector | Implemented |
| Mock connectors | Implemented |
| Tenant-aware authorization | Implemented |
| PostgreSQL RLS | Implemented |
| Formal load benchmarks | Pending |
| Long-lived worker hosting | Planned |
| Multi-region execution | Planned |
| Expanded connector ecosystem | Planned |
| Independent security audit | Not completed |
| HIPAA certification | Not claimed |
| SOC 2 certification | Not claimed |
| Commercial production deployment | Not claimed |

---

# Roadmap

## Near Term

- Expand runtime integration testing.
- Establish reproducible load-test methodology.
- Publish measured queue and workflow performance baselines.
- Expand connector coverage.
- Strengthen operational diagnostics.
- Continue hardening workflow recovery paths.

## Runtime

- Long-lived worker hosting.
- More advanced worker coordination.
- Improved stale-job recovery.
- Expanded runtime observability.
- Additional replay diagnostics.

## Enterprise-Oriented Features

- SSO integration.
- Expanded identity providers.
- More granular organization hierarchies.
- Advanced audit reporting.
- Configurable retention policies.
- Additional administrative controls.

These are planned capabilities, not claims about the current release.

## Infrastructure

- Multi-region execution.
- Regional worker placement.
- Improved failover behavior.
- Expanded backup and recovery automation.

## AI

Future work may include:

- richer AI decision workflows;
- configurable confidence thresholds;
- human escalation;
- expanded AI decision tracing;
- additional model providers.

AI remains one capability within the broader orchestration runtime rather than the definition of the platform itself.

---

# Documentation

| Document | Description |
| --- | --- |
| Runtime Documentation | Workflow execution, workers, replay, telemetry, and runtime behavior |
| Platform Documentation | Templates, deployment, onboarding, and platform workflows |
| `STATUS.md` | Current, partial, and planned capabilities |
| `CHANGELOG.md` | Delivery history and project evolution |

---

# Screenshots

Screenshots and architecture diagrams can be added here as the visual demonstration package is finalized.

Recommended evidence includes:

- operator command center;
- workflow studio;
- workflow execution;
- runtime inspector;
- approval workflow;
- incident view;
- telemetry dashboard;
- replay interface;
- database architecture;
- repository structure.

---

# Engineering Approach

Valtaris Glue is developed using an iterative engineering process:

```text
Design
  ↓
Implement
  ↓
Test
  ↓
Inspect Runtime Behavior
  ↓
Identify Gaps
  ↓
Remediate
  ↓
Retest
  ↓
Document
```

The project emphasizes:

- durable state over transient browser state;
- explicit workflow versions;
- deterministic execution boundaries;
- database-enforced authorization;
- observable runtime behavior;
- recoverable failures;
- clear separation between implemented and planned capabilities.

---

# Contributing

Follow the existing repository conventions for:

- TypeScript;
- React;
- Supabase Edge Functions;
- PostgreSQL;
- runtime documentation.

Before submitting changes where applicable, run:

```bash
bun run lint
bun run test
bun run build
```

Keep changes scoped and reviewable.

Changes involving workflow execution should preserve:

- workflow versioning;
- tenant boundaries;
- durable state;
- retry semantics;
- authorization;
- runtime observability.

Do not weaken authorization or persistence guarantees simply to make a test pass.

---

# License

No explicit license file is currently present in the repository.

Define a project license before external distribution.

---

# Author

**George Rios**

Independent Software Engineer

**Valtaris Technologies**

---

# Acknowledgements

Built with React, Vite, Tailwind CSS, Supabase, PostgreSQL, Supabase Edge Functions, Vitest, Playwright, and the open-source ecosystem supporting the project's runtime and development tooling.
