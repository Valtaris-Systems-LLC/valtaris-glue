// src/connectors/http/http-binding.ts
// Valtaris Glue — HTTP Binding
//
// Connects the HTTP connector to the DSL + WorkflowRunner:
// - exposes "http.get", "http.post", etc.
// - allows DSL workflows to call external APIs
// - registers HTTP tasks with the runtime

import { HttpTask } from "./http-task";
import { WorkflowRunner } from "../../orchestration/workflow-runner";

export class HttpBinding {
  private task = new HttpTask();

  constructor(private runner: WorkflowRunner) {
    this.register();
  }

  private register() {
    this.runner.registerTask("http.get", async (input) => {
      return await this.task.run("get", input.url);
    });

    this.runner.registerTask("http.post", async (input) => {
      return await this.task.run("post", input.url, input.body);
    });

    this.runner.registerTask("http.put", async (input) => {
      return await this.task.run("put", input.url, input.body);
    });

    this.runner.registerTask("http.delete", async (input) => {
      return await this.task.run("delete", input.url);
    });
  }
}
