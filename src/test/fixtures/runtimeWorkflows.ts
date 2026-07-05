import type { DagGraph } from "../../../supabase/functions/_shared/dag.ts";
import type { ReplayStep } from "../../../supabase/functions/replay-workflow/logic.ts";

export const happyPathWorkflow: DagGraph = {
  nodes: [
    { id: "ingest", name: "Ingest order", connector: "internal" },
    { id: "charge", name: "Charge card", connector: "stripe", dependsOn: ["ingest"], maxRetries: 4 },
    { id: "notify", name: "Notify customer", connector: "sendgrid", dependsOn: ["charge"] },
  ],
};

export const failingWorkflow: DagGraph = {
  nodes: [
    { id: "ingest", name: "Ingest order", connector: "internal" },
    { id: "ship", name: "Create shipment", connector: "salesforce", dependsOn: ["ingest"], maxRetries: 2 },
  ],
};

export const approvalWorkflow: DagGraph = {
  nodes: [
    { id: "review", name: "Manager review", connector: "internal", approvalRequired: true },
    { id: "release", name: "Release funds", connector: "stripe", dependsOn: ["review"] },
  ],
};

export const replaySteps: ReplayStep[] = [
  { name: "Ingest order", connector: "internal", duration_ms: 100 },
  { name: "Charge card", connector: "stripe", duration_ms: 120 },
  { name: "Notify customer", connector: "sendgrid", duration_ms: 80 },
];
