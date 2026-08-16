# Valtaris Glue

> Enterprise workflow orchestration runtime for governed, replayable, telemetry-native automation across connectors, approvals, and durable background execution.

---

## Table of Contents

- [Overview](#overview)
- [Why This Exists](#why-this-exists)
- [Core Capabilities](#core-capabilities)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Core Workflows](#core-workflows)
- [Security](#security)
- [Database Design](#database-design)
- [Runtime and API](#runtime-and-api)
- [Installation](#installation)
- [Configuration](#configuration)
- [Testing and Verification](#testing-and-verification)
- [Deployment](#deployment)
- [Performance and Scalability](#performance-and-scalability)
- [Capability Status](#capability-status)
- [Known Limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [Screenshots](#screenshots)
- [Contributing](#contributing)
- [License](#license)
- [Author](#author)

---

# Overview

Valtaris Glue is a workflow orchestration runtime designed to execute operational automations with durable state, governed execution, approvals, recovery paths, telemetry, and replayability.

The system combines a React operator console with Supabase/PostgreSQL-backed runtime services, queue-driven workers, workflow versioning, approval gates, connector adapters, rollback mechanisms, and operational telemetry.

The core design principle is:

> **Workflow execution should be durable, observable, recoverable, and governed rather than dependent on a browser session or a collection of disconnected scripts.**

Valtaris Glue is an independent engineering project and research implementation. It is not represented as independently certified, independently audited, or commercially deployed enterprise infrastructure.

---

# Why This Exists

Modern operations teams frequently automate processes across multiple SaaS platforms, APIs, databases, and internal systems.

Without durable orchestration, these workflows can become difficult to:

- observe;
- retry;
- recover;
- audit;
- replay;
- version;
- govern;
- debug.

A workflow that fails halfway through execution should not require an operator to reconstruct what happened from browser logs, scattered API calls, or transient application state.

Valtaris Glue explores a different model:

```text
Trigger
   ↓
Published Workflow Version
   ↓
DAG Expansion
   ↓
Durable Jobs
   ↓
Worker Execution
   ↓
Telemetry + Checkpoints
   ↓
Dependency Resolution
   ↓
Completion / Retry / Approval / Rollback
```

The database acts as the durable system of record for workflow execution.

---

# Core Capabilities

## Durable Workflow Execution

- Queue-backed workflow execution
- Durable job persistence
- Worker leasing
- Retry handling
- Dead-letter handling
- Stale-job recovery
- Checkpoint persistence
- Background execution independent of browser sessions

## Workflow Versioning

Published workflows are pinned to a specific version when execution begins.

This prevents later workflow edits from unexpectedly changing the behavior of an already-running workflow.

```text
Draft
  ↓
Validation
  ↓
Published Version
  ↓
Execution
  ↓
Pinned Runtime
```

## DAG Orchestration

Workflows can represent dependency-aware execution across multiple steps.

The runtime supports:

- dependent steps;
- parallel execution;
- branching;
- approval gates;
- compensation;
- rollback;
- retry;
- failure routing.

## Governance

Workflow execution can incorporate:

- approval requirements;
- confidence thresholds;
- tenant-scoped policies;
- operator intervention;
- audit-oriented events;
- deployment validation.

## Replay

The runtime stores execution history and checkpoints that can be used to reconstruct workflow activity.

Replay is designed primarily as an observational and diagnostic capability rather than an unrestricted duplicate execution mechanism.

## Telemetry

Runtime activity generates structured events and metrics covering areas such as:

- workflow execution;
- job state;
- queue pressure;
- latency;
- worker activity;
- failures;
- approvals;
- incidents;
- connector activity.

---

# Architecture

## High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                     React Operator Console                  │
│                                                             │
│ Command Center · Workflow Studio · Runtime Inspector        │
│ Approvals · Incidents · Telemetry · Platform Controls       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               │ Authenticated API
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                       Supabase Runtime                      │
│                                                             │
│  PostgreSQL       Edge Functions       Realtime              │
│  ──────────       ──────────────       ────────              │
│  Workflows        Execution            Runtime Events        │
│  Runs             Workers              Dashboard Updates     │
│  Jobs             Replay               Telemetry              │
│  Checkpoints      Approvals            Operational State      │
│  Incidents        Rollback                                     │
│                                                             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Connector / Runtime Layer                 │
│                                                             │
│ Stripe · OpenAI · SendGrid · Slack · Twilio · Salesforce    │
│                                                             │
│                 Adapter-Based Execution                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Frontend

The operator console is built with React and TypeScript.

Primary areas include:

- Command Center;
- Workflow Studio;
- Runtime Inspector;
- workflow management;
- approvals;
- incidents;
- telemetry;
- platform administration.

The UI is designed around operational visibility rather than simply providing CRUD interfaces.

---

## Backend

Supabase provides:

- PostgreSQL;
- Authentication;
- Row-Level Security;
- Edge Functions;
- Realtime;
- persistent runtime state.

Edge Functions provide execution boundaries for workers, scheduling, replay, rollback, ingress, approvals, and platform operations.

---

## Worker Runtime

Workers claim eligible jobs from the durable queue.

The execution model uses PostgreSQL locking and leases to reduce duplicate claims and provide recovery when a worker becomes unavailable.

Conceptually:

```text
Queued Job
    ↓
Eligibility Check
    ↓
Lease / Claim
    ↓
Execution
    ↓
Persist Result
    ↓
Emit Telemetry
    ↓
Unlock Dependencies
```

Failures can enter retry, incident, compensation, or dead-letter paths depending on runtime classification.

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
- Supabase Authentication
- Supabase Realtime

## Testing

- Vitest
- Playwright

## Development

- Bun
- Git
- GitHub

## Integrations

Current connector-oriented workflows include integrations for:

- Stripe;
- OpenAI;
- SendGrid.

Additional adapters and mock-capable integration pathways support future expansion.

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

## Workflow Execution

A published workflow version is selected and pinned when a run begins.

The runtime expands the workflow definition into durable jobs and executes eligible nodes as their dependencies become satisfied.

```text
Published Workflow
        ↓
Pinned Version
        ↓
Workflow Run
        ↓
DAG Expansion
        ↓
Durable Jobs
        ↓
Worker Claims
        ↓
Step Execution
        ↓
Result + Telemetry
        ↓
Dependent Jobs
        ↓
Completion
```

---

## Approval Workflow

Certain workflow steps can require human intervention before execution continues.

```text
Workflow Step
      ↓
Policy Evaluation
      ↓
Approval Required?
   ↙          ↘
 No            Yes
 ↓              ↓
Continue      Approval Queue
                 ↓
          Operator Decision
             ↙       ↘
          Approve    Reject
             ↓         ↓
         Continue    Failure /
                     Rollback
```

The purpose is to prevent sensitive or uncertain actions from proceeding without the required governance decision.

---

## Retry and Recovery

Runtime failures are classified and routed according to execution policy.

```text
Execution Failure
       ↓
Error Classification
       ↓
Retryable?
   ↙        ↘
 Yes         No
 ↓            ↓
Backoff      Incident /
 ↓           Terminal Path
Retry
 ↓
Success / Retry Exhausted
          ↓
       DLQ / Recovery
```

The runtime persists job state so recovery does not depend exclusively on an active browser session.

---

## Rollback and Compensation

Workflow failures can trigger compensation paths where the workflow defines them.

The objective is not to claim universal transactional rollback across external systems.

Instead, Glue provides an orchestration mechanism for explicit compensation actions defined by the workflow.

---

## Replay

Replay reconstructs workflow execution from durable state, checkpoints, and event history.

The current design treats replay primarily as an observational and diagnostic capability.

This allows operators to investigate:

- what executed;
- in what order;
- which dependencies were satisfied;
- where failures occurred;
- what telemetry was emitted;
- what state existed at important checkpoints.

---

# Security

## Authentication

Supabase Authentication provides authenticated identity and JWT-based access.

---

## Authorization

Authorization uses organization-aware access controls and role checks across operational paths.

PostgreSQL Row-Level Security provides a database-level authorization boundary rather than relying solely on frontend behavior.

---

## Multi-Tenant Isolation

Operational records are designed around tenant/organization boundaries.

The security model uses:

- organization identifiers;
- authenticated identity;
- role-aware access;
- PostgreSQL RLS;
- server-side authorization checks.

The application does not treat a browser-supplied tenant identifier as sufficient authorization.

---

## Secrets

Client-side configuration is limited to values appropriate for browser exposure.

Sensitive connector credentials and service-side secrets are intended to remain server-side.

Service-role credentials must never be exposed through `VITE_` variables or committed to source control.

---

## Auditability

Runtime activity produces structured operational records covering areas such as:

- workflow state;
- job execution;
- approvals;
- incidents;
- connector activity;
- telemetry;
- operator actions.

The project is designed around auditability, but does not claim that every operational event currently forms a formally immutable compliance audit record.

---

## Error Handling

Runtime errors are classified so the system can distinguish between:

- retryable failures;
- terminal failures;
- approval-required states;
- rollback/compensation paths;
- dead-letter conditions.

This prevents every failure from being treated identically.

---

# Database Design

PostgreSQL acts as the durable system of record for workflow execution.

Representative runtime domains include:

| Domain | Representative Data |
|---|---|
| Workflow definitions | workflows, versions |
| Execution | workflow_runs |
| Queue | workflow_jobs |
| Step execution | workflow_step_runs |
| Checkpoints | workflow_checkpoints |
| Events | workflow_events |
| Approvals | workflow_approvals |
| Incidents | workflow_incidents |
| Telemetry | runtime telemetry / aggregate records |
| Governance | policies / deployment validation |
| Connectors | connector configuration and execution metadata |

Core relationships follow the workflow lifecycle:

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

The queue design relies on durable job state, eligibility conditions, leases, retry timing, and dependency relationships.

---

# Runtime and API

Primary runtime functions include:

| Runtime Function | Purpose |
|---|---|
| `execute-workflow` | Starts a workflow run from a published version |
| `run-worker` | Claims and executes queued jobs |
| `approval-decision` | Processes approval decisions |
| `rollback-executor` | Executes defined compensation paths |
| `replay-workflow` | Reconstructs workflow execution |
| `webhook-ingress` | Starts workflows from external events |
| `scheduler-tick` | Dispatches scheduled workflows |
| `scale-monitor` | Reports queue pressure and scaling signals |

The exact function surface may evolve as runtime boundaries are consolidated.

---

# Installation

## Prerequisites

- Bun
- Access to a Supabase project or compatible runtime environment

## Clone

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

Client-side Supabase configuration is documented in `.env.example`.

Typical browser-safe configuration includes:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
VITE_SUPABASE_PROJECT_ID
```

Backend integrations and sensitive credentials must be configured as server-side secrets.

Supported connector configurations may include:

- Stripe;
- OpenAI;
- SendGrid;
- Slack;
- Twilio;
- Salesforce.

Where supported, mock-capable adapters can be used for development without live third-party credentials.

---

# Testing and Verification

## Unit Tests

Vitest is used for application and runtime testing.

Typical test areas include:

- workflow state;
- DAG behavior;
- queue logic;
- retry handling;
- runtime utilities;
- governance logic;
- connector behavior.

## Browser Testing

Playwright is available for browser-level validation of operator workflows.

## Build Validation

The project should be validated with:

```bash
bun run lint
bun run test
bun run build
```

Where configured, Playwright workflows can be executed separately.

## Load Testing

The repository includes runtime tooling for synthetic workload generation and queue behavior analysis.

Formal production-scale throughput and latency baselines are not currently claimed.

---

# Deployment

## Development

Run the Vite development environment against the configured Supabase project.

## Staging

A staging deployment should use:

- a separate Supabase environment;
- staging secrets;
- deployed Edge Functions;
- applied migrations;
- representative workflow validation.

## Production

A production deployment should include:

- controlled Supabase infrastructure;
- server-side secrets;
- deployed Edge Functions;
- database migrations;
- monitoring;
- worker health checks;
- queue recovery procedures;
- operational alerting.

The repository contains deployment-oriented infrastructure, but the project is not represented as a commercially deployed enterprise production platform.

---

# Performance and Scalability

The runtime is designed with several scalability-oriented characteristics:

- durable queueing;
- dependency-aware scheduling;
- worker leasing;
- retry backoff;
- background execution;
- persisted checkpoints;
- realtime operational updates;
- queue pressure monitoring;
- horizontal worker scaling potential.

The architecture is intended to support increased concurrency, but formal production-scale benchmarks have not been established.

The project therefore does **not** claim specific:

- requests per second;
- workflow throughput;
- maximum concurrent workers;
- p95/p99 latency;
- multi-region performance.

Those measurements remain future validation work.

---

# Capability Status

Valtaris Glue intentionally distinguishes implemented capabilities from capabilities that still require additional validation or production hardening.

| Capability | Current Position |
|---|---|
| Durable workflow jobs | Implemented |
| Workflow version pinning | Implemented |
| DAG execution | Implemented |
| Worker leasing | Implemented |
| Retry handling | Implemented |
| Dead-letter handling | Implemented |
| Checkpoints | Implemented |
| Approval workflows | Implemented |
| Rollback / compensation framework | Implemented |
| Runtime telemetry | Implemented |
| Operator console | Implemented |
| Replay infrastructure | Implemented |
| Connector adapter model | Implemented |
| Multi-tenant architecture | Implemented |
| RLS architecture | Implemented |
| RBAC | Implemented |
| Formal production load benchmarks | Pending |
| Long-lived production worker infrastructure | Future hardening |
| Multi-region execution | Roadmap |
| Enterprise SSO | Roadmap |
| Comprehensive external compliance audit | Not completed |
| Commercial production deployment | Not claimed |

---

# Known Limitations

## Production Deployment

The repository should not be represented as a commercially deployed enterprise orchestration platform without corresponding deployment evidence.

## Performance

Formal production-scale benchmarking has not been completed.

## Multi-Region

Multi-region execution and regional failover remain future architecture work.

## Compliance

The architecture incorporates security, governance, tenant isolation, and audit-oriented patterns.

However, the project is not represented as:

- SOC 2 certified;
- HIPAA certified;
- independently audited;
- legally compliant for a specific regulated deployment;
- production-authorized for regulated workloads.

Compliance depends on the complete deployment, organizational controls, operational procedures, and applicable legal requirements.

## External Connectors

Connector support varies by integration.

Live third-party behavior depends on external API credentials, API availability, rate limits, and provider-specific semantics.

## Replay

Replay is designed primarily for reconstruction and analysis.

It should not be interpreted as universal exactly-once re-execution across external systems.

---

# Roadmap

## Near Term

- Expand automated runtime verification.
- Establish formal queue and workflow benchmarks.
- Expand connector coverage.
- Strengthen worker lifecycle management.
- Improve operational alerting.
- Expand failure and recovery test scenarios.

## Enterprise Operations

- SSO;
- stronger MFA enforcement;
- advanced organization hierarchies;
- expanded observability;
- distributed tracing;
- operational SLOs;
- error budgets;
- enhanced administrative controls.

## Scalability

- long-lived worker infrastructure;
- horizontal worker orchestration;
- regional execution controls;
- multi-region failover;
- higher-cardinality telemetry optimization.

## Connector Ecosystem

Potential future adapters include:

- Slack;
- Twilio;
- Salesforce;
- additional payment providers;
- additional communication platforms;
- internal enterprise APIs.

## Intelligence

Future development may expand AI-assisted workflow capabilities while maintaining:

- governance boundaries;
- confidence thresholds;
- human approval;
- decision traceability.

AI is treated as an orchestration capability rather than an uncontrolled replacement for deterministic workflow rules.

---

# Documentation

| Document | Purpose |
|---|---|
| `docs/runtime/` | Runtime architecture, workers, orchestration, replay, and telemetry |
| `docs/platform/` | Platform capabilities, templates, deployment, and operational guidance |
| `docs/STATUS.md` | Current capability and implementation status |
| `CHANGELOG.md` | Project delivery history and evolution |

---

# Screenshots

Screenshots and architecture diagrams can be added here to demonstrate:

- Command Center;
- Workflow Studio;
- Runtime Inspector;
- workflow execution;
- approvals;
- incidents;
- telemetry;
- connector configuration;
- replay workflows.

The primary technical evidence remains the source code, database migrations, runtime functions, tests, and documented architecture.

---

# Engineering Approach

Valtaris Glue has been developed around an iterative engineering process:

```text
Design
  ↓
Implement
  ↓
Test
  ↓
Inspect Runtime Behavior
  ↓
Identify Failure Modes
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
- database-backed execution;
- deterministic dependency handling;
- observable runtime behavior;
- controlled retries;
- explicit recovery paths;
- tenant-aware authorization;
- evidence-based capability claims.

---

# Contributing

For development changes:

1. Create a focused feature or fix branch.
2. Preserve existing runtime boundaries.
3. Add tests for meaningful behavior changes.
4. Preserve tenant authorization.
5. Avoid exposing server-side secrets.
6. Validate workflow changes against existing runtime behavior.
7. Update documentation when runtime contracts change.
8. Use pull requests for reviewable changes.

Recommended validation:

```bash
bun run lint
bun run test
bun run build
```

---

# License

No explicit license is currently claimed unless a license file is present in the repository.

Define the project license before external distribution.

---

# Author

**George Rios**

Founder & Software Engineer

**Valtaris Technologies**

---

# Project Positioning

Valtaris Glue is an independent engineering project focused on durable workflow orchestration, governed automation, replayable runtime state, connector execution, and operational observability.

It is intended to demonstrate the engineering patterns required to build reliable workflow infrastructure rather than claim that every enterprise production concern has already been solved.

```
