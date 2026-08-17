// src/orchestration/dsl-binding.ts
// Valtaris Glue — DSL Binding Layer
//
// Connects the DSL system to the runtime engine:
// - validates DSL workflows
// - compiles DSL → executable workflow graph
// - executes compiled workflows via DSLExecutor
// - emits lifecycle events
//
// This is the top-level entry point for DSL-based workflow execution.

import { DSLWorkflow } from "./dsl-types";
import { DSLValidator } from "./dsl-validator";
import { DSLCompiler } from "./dsl-compiler";
import { DSLExecutor } from "./dsl-executor";
import { WorkflowRunner } from "./workflow-runner";

export class DSLBinding {
  private validator = new DSLValidator();
  private compiler = new DSLCompiler();
  private executor: DSLExecutor;

  constructor(private runner: WorkflowRunner) {
    this.executor = new DSLExecutor(runner);
  }

  async run(workflow: DSLWorkflow, payload: Record<string, unknown> = {}) {
    const emitter = (this.runner as any).events;

    emitter.emit("workflow.dsl.binding.start", {
      workflowId: workflow.id,
      payload,
    });

    // 1. Validate DSL
    this.validator.validate(workflow);

    // 2. Compile DSL → executable workflow
    const compiled = this.compiler.compile(workflow);

    emitter.emit("workflow.dsl.binding.compiled", {
      workflowId: workflow.id,
      steps: compiled.steps.length,
    });

    // 3. Execute compiled workflow
    await this.executor.execute(compiled, payload);

    emitter.emit("workflow.dsl.binding.completed", {
      workflowId: workflow.id,
    });
  }
}
