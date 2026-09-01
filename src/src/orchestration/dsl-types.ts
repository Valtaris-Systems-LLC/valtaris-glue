// src/orchestration/dsl-types.ts
// Valtaris Glue — Workflow DSL Types
//
// Defines the declarative DSL for workflows:
// - steps
// - dependencies
// - inputs/outputs
// - parallel blocks
// - conditional blocks
//
// This is the foundation of the workflow language.

export type DSLStepType =
  | "task"
  | "parallel"
  | "condition"
  | "branch";

export interface DSLBase {
  id: string;
  name?: string;
  dependsOn?: string[];
}

export interface DSLTask extends DSLBase {
  type: "task";
  run: string; // reference to a job handler
  input?: Record<string, unknown>;
}

export interface DSLParallel extends DSLBase {
  type: "parallel";
  tasks: DSLTask[];
}

export interface DSLCondition extends DSLBase {
  type: "condition";
  expression: string; // JS expression evaluated at runtime
  ifTrue: DSLStep[];
  ifFalse?: DSLStep[];
}

export interface DSLBranch extends DSLBase {
  type: "branch";
  branches: Record<string, DSLStep[]>;
}

export type DSLStep =
  | DSLTask
  | DSLParallel
  | DSLCondition
  | DSLBranch;

export interface DSLWorkflow {
  id: string;
  name?: string;
  steps: DSLStep[];
}
