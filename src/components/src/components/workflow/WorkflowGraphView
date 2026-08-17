// src/components/workflow/WorkflowGraphView.tsx
// Valtaris Glue — Workflow Graph View
//
// Displays workflow structure as a node graph:
// - steps as nodes
// - dependencies as edges
// - color-coded state
//
// This is the visual workflow graph component.

import React from "react";

export interface GraphNode {
  id: string;
  label: string;
  state: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

interface WorkflowGraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function WorkflowGraphView({ nodes, edges }: WorkflowGraphViewProps) {
  return (
    <div className="border rounded-lg p-4 bg-white shadow-sm">
      <h2 className="text-lg font-semibold mb-4">Workflow Graph</h2>

      <div className="overflow-auto">
        <svg width="800" height="600" className="bg-gray-50 rounded">
          {/* Draw edges */}
          {edges.map((edge, idx) => {
            const fromIndex = nodes.findIndex((n) => n.id === edge.from);
            const toIndex = nodes.findIndex((n) => n.id === edge.to);

            const x1 = 150;
            const y1 = 50 + fromIndex * 80;

            const x2 = 450;
            const y2 = 50 + toIndex * 80;

            return (
              <line
                key={idx}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#999"
                strokeWidth="2"
                markerEnd="url(#arrowhead)"
              />
            );
          })}

          {/* Arrowhead marker */}
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="7"
              refX="10"
              refY="3.5"
              orient="auto"
            >
              <polygon points="0 0, 10 3.5, 0 7" fill="#999" />
            </marker>
          </defs>

          {/* Draw nodes */}
          {nodes.map((node, idx) => {
            const x = 100;
            const y = 50 + idx * 80;

            const color =
              node.state === "completed"
                ? "green"
                : node.state === "failed"
                ? "red"
                : node.state === "running"
                ? "blue"
                : "gray";

            return (
              <g key={node.id}>
                <rect
                  x={x}
                  y={y}
                  width="200"
                  height="50"
                  rx="8"
                  fill={color}
                  opacity="0.15"
                  stroke={color}
                  strokeWidth="2"
                />
                <text
                  x={x + 100}
                  y={y + 30}
                  textAnchor="middle"
                  className="text-sm fill-gray-800"
                >
                  {node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
