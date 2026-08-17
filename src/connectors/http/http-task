// src/connectors/http/http-task.ts
// Valtaris Glue — HTTP Task
//
// Wraps HttpClient into a workflow-executable task:
// - run GET/POST/PUT/DELETE inside workflows
// - integrates with WorkflowRunner
// - supports DSL "run: http.get" style commands

import { HttpClient } from "./http-client";

export class HttpTask {
  private client = new HttpClient();

  async run(method: string, url: string, payload?: any) {
    switch (method.toLowerCase()) {
      case "get":
        return await this.client.get(url);

      case "post":
        return await this.client.post(url, payload);

      case "put":
        return await this.client.put(url, payload);

      case "delete":
        return await this.client.delete(url);

      default:
        throw new Error(`http.invalid_method: '${method}'`);
    }
  }
}
