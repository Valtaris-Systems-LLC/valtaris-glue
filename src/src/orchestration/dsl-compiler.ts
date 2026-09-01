// src/orchestration/dsl-compiler.ts
// Valtaris Glue — Workflow DSL Compiler
//
// Converts DSLWorkflow → Executable Workflow Graph:
// - resolves dependencies
// - flattens parallel blocks
// - expands conditional blocks
// - expands branch blocks
// - produces a normalized execution plan
//
// This is the heart of the workflow language.

import {
  DSLWorkflow,
  DSLStep,
  DSLTask,
  DSLParallel,
  DSLCondition,
  DSLBranch,
} from "./dsl-types";

export interface CompiledStep {
  id: string;
  type: string;
  run?: string;
  dependsOn: string[];
  payload?: Record<string, unknown>;
}

export interface CompiledWorkflow {
  id: string;
  steps: CompiledStep[];
}

export class DSLCompiler {
  compile(workflow: DSLWorkflow): CompiledWorkflow {
    const compiled: CompiledStep[] = [];

    for (const step of workflow.steps) {
      const expanded = this.expandStep(step);
      compiled.push(...expanded);
    }

    return {
      id: workflow.id,
      steps: compiled,
    };
  }

  private expandStep(step: DSLStep): CompiledStep[] {
    switch (step.type) {
      case "task":
        return [this.compileTask(step as DSLTask)];

      case "parallel":
        return this.compileParallel(step as DSLParallel);

      case "condition":
        return this.compileCondition(step as DSLCondition);

      case "branch":
        return this.compileBranch(step as DSLBranch);

      default:
        throw new Error(`dsl.compiler.invalid_step_type: '${(step as any).type}'`);
    }
  }

  private compileTask(step: DSLTask): CompiledStep {
    return {
      id: step.id,
      type: "task",
      run: step.run,
      dependsOn: step.dependsOn ?? [],
      payload: step.input ?? {},
    };
  }

  private compileParallel(step: DSLParallel): CompiledStep[] {
    return step.tasks.map((task) => ({
      id: `${step.id}:${task.id}`,
      type: "task",
      run: task.run,
      dependsOn: step.dependsOn ?? [],
      payload: task.input ?? {},
    }));
  }

  private compileCondition(step: DSLCondition): CompiledStep[] {
    const trueSteps = step.ifTrue.map((s) => ({
      id: `${step.id}:true:${s.id}`,
      type: s.type,
      run: (s as DSLTask).run,
      dependsOn: step.dependsOn ?? [],
      payload: (s as DSLTask).input ?? {},
    }));

    const falseSteps = (step.ifFalse ?? []).map((s) => ({
      id: `${step.id}:false:${s.id}`,
      type: s.type,
      run: (s as DSLTask).run,
      dependsOn: step.dependsOn ?? [],
      payload: (s as DSLTask).input ?? {},
    }));

    return [...trueSteps, ...falseSteps];
  }

  private compileBranch(step: DSLBranch): CompiledStep[] {
    const compiled: CompiledStep[] = [];

    for (const branchName of Object.keys(step.branches)) {
      const branchSteps = step.branches[branchName];

      for (const s of branchSteps) {
        compiled.push({
          id: `${step.id}:${branchName}:${s.id}`,
          type: s.type,
          run: (s as DSLTask).run,
          dependsOn: step.dependsOn ?? [],
          payload: (s as DSLTask).input ?? {},
        });
      }
    }

    return compiled;
  }
}
