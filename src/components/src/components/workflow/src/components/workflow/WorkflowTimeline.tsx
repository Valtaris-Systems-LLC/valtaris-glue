// src/components/workflow/WorkflowTimeline.tsx
// Valtaris Glue — Workflow Timeline
//
// Displays a chronological timeline of workflow events:
// - step start
// - step completion
// - state transitions
// - snapshots
//
// This is the visual execution timeline for workflow runs.

import React from "react";

export interface TimelineEvent {
  id: string;
  label: string;
  timestamp: string;
  type: "start" | "complete" | "snapshot" | "state";
}

interface WorkflowTimelineProps {
  events: TimelineEvent[];
}

export function WorkflowTimeline({ events }: WorkflowTimelineProps) {
  return (
    <div className="border rounded-lg p-4 bg-white shadow-sm">
      <h2 className="text-lg font-semibold mb-4">Execution Timeline</h2>

      <div className="relative">
        <div className="absolute left-4 top-0 bottom-0 w-1 bg-gray-200 rounded"></div>

        <div className="space-y-6 ml-10">
          {events.map((event) => (
            <div key={event.id} className="relative">
              <div
                className={`absolute -left-6 top-1 w-4 h-4 rounded-full border ${
                  event.type === "complete"
                    ? "bg-green-500 border-green-600"
                    : event.type === "start"
                    ? "bg-blue-500 border-blue-600"
                    : event.type === "snapshot"
                    ? "bg-purple-500 border-purple-600"
                    : "bg-gray-500 border-gray-600"
                }`}
              ></div>

              <div>
                <p className="font-medium text-gray-800">{event.label}</p>
                <p className="text-xs text-gray-500">{event.timestamp}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
