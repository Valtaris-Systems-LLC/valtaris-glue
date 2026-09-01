// src/orchestration/dsl-validator.ts
// Valtaris Glue — Workflow DSL Validator
//
// Validates DSL workflows:
// - step uniqueness
// - dependency correctness
// - valid types
// - no circular dependencies
// - structural integrity
//
// This ensures workflows are safe before compilation.

import {
  DSLWorkflow,
  DSLStep,
  DSLTask,
  DSLParallel,
  DSLCondition,
  DSLBranch,
} from "./dsl-types";

export class DSLValidator {
  validate(workflow: DSLWorkflow) {
    this.ensureUniqueStepIds(workflow);
    this.ensureValidDependencies(workflow);
    this.ensureNoCycles(workflow);
    this.ensureValidTypes(workflow);
  }

  private ensureUniqueStepIds(workflow: DSLWorkflow) {
    const ids = new Set<string>();

    for (const step of workflow.steps) {
      if (ids.has(step.id)) {
        throw new Error(`dsl.duplicate_step_id: '${step.id}'`);
      }
      ids.add(step.id);
    }
  }

  private ensureValidDependencies(workflow: DSLWorkflow) {
    const ids = new Set(workflow.steps.map((s) => s.id));

    for (const step of workflow.steps) {
      if (!step.dependsOn) continue;

      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) {
          throw new Error(
            `dsl.invalid_dependency: step '${step.id}' depends on missing '${dep}'`
          );
        }
      }
    }
  }

  private ensureNoCycles(workflow: DSLWorkflow) {
    const graph: Record<string, string[]> = {};

    for (const step of workflow.steps) {
      graph[step.id] = step.dependsOn ?? [];
    }

    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (node: string) => {
      if (stack.has(node)) {
        throw new Error(`dsl.cycle_detected: '${node}'`);
      }
      if (visited.has(node)) return;

      visited.add(node);
      stack.add(node);

      for (const dep of graph[node]) {
        dfs(dep);
      }

      stack.delete(node);
    };

    for (const step of workflow.steps) {
      dfs(step.id);
    }
  }

  private ensureValidTypes(workflow: DSLWorkflow) {
    for (const step of workflow.steps) {
      switch (step.type) {
        case "task":
          this.validateTask(step as DSLTask);
          break;

        case "parallel":
          this.validateParallel(step as DSLParallel);
          break;

        case "condition":
          this.validateCondition(step as DSLCondition);
          break;

        case "branch":
          this.validateBranch(step as DSLBranch);
          break;

        default:
          throw new Error(`dsl.invalid_step_type: '${(step as any).type}'`);
      }
    }
  }

  private validateTask(step: DSLTask) {
    if (!step.run) {
      throw new Error(`dsl.task_missing_run: '${step.id}'`);
    }
  }

  private validateParallel(step: DSLParallel) {
    if (!step.tasks || step.tasks.length === 0) {
      throw new Error(`dsl.parallel_empty: '${step.id}'`);
    }
  }

  private validateCondition(step: DSLCondition) {
    if (!step.expression) {
      throw new Error(`dsl.condition_missing_expression: '${step.id}'`);
    }
    if (!step.ifTrue || step.ifTrue.length === 0) {
      throw new Error(`dsl.condition_missing_ifTrue: '${step.id}'`);
    }
  }

  private validateBranch(step: DSLBranch) {
    if (!step.branches || Object.keys(step.branches).length === 0) {
      throw new Error(`dsl.branch_empty: '${step.id}'`);
    }
  }
}
