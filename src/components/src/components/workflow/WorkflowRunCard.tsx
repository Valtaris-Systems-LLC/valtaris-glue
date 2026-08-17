// src/components/workflow/WorkflowRunCard.tsx
// Valtaris Glue — Workflow Run Card
//
// Displays:
// - runId
// - workflow name
// - current state
// - timestamps
// - quick actions
//
// This is the primary UI element for viewing workflow runs.

import React from "react";

interface WorkflowRunCardProps {
  runId: string;
  workflowName?: string;
  state: string;
  startedAt?: string;
  updatedAt?: string;
  onOpen?: () => void;
}

export function WorkflowRunCard({
  runId,
  workflowName,
  state,
  startedAt,
  updatedAt,
  onOpen,
}: WorkflowRunCardProps) {
  return (
    <div className="border rounded-lg p-4 shadow-sm bg-white hover:shadow-md transition">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-lg font-semibold">
          {workflowName ?? "Workflow"} — {runId}
        </h2>
        <span
          className={`px-2 py-1 rounded text-sm ${
            state === "completed"
              ? "bg-green-100 text-green-700"
              : state === "failed"
              ? "bg-red-100 text-red-700"
              : "bg-blue-100 text-blue-700"
          }`}
        >
          {state}
        </span>
      </div>

      <div className="text-sm text-gray-600 space-y-1">
        {startedAt && <p>Started: {startedAt}</p>}
        {updatedAt && <p>Updated: {updatedAt}</p>}
      </div>

      <button
        onClick={onOpen}
        className="mt-3 px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
      >
        Open Run
      </button>
    </div>
  );
}
