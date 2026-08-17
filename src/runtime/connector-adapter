// src/runtime/connector-adapter.ts
// Valtaris Glue — Connector Adapter Layer
//
// This module is responsible for:
// - Registering connectors
// - Normalizing input/output schemas
// - Executing connectors safely
// - Classifying connector errors
// - Providing a unified connector contract for the worker runtime
//
// This is the core abstraction that allows Glue to support
// product-level connectors, custom connectors, and Nucleus-governed connectors.

export interface ConnectorExecutionContext {
  connectorKey: string;
  payload: Record<string, unknown>;
}

export interface ConnectorOutput {
  success: boolean;
  output?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export type ConnectorHandler = (
  payload: Record<string, unknown>
) => Promise<Record<string, unknown>>;

export interface ConnectorDefinition {
  key: string;
  name: string;
  description?: string;
  handler: ConnectorHandler;
}

export class ConnectorAdapter {
  private registry: Map<string, ConnectorDefinition> = new Map();

  /**
   * Register a connector.
   */
  register(def: ConnectorDefinition) {
    if (this.registry.has(def.key)) {
      throw new Error(`Connector '${def.key}' is already registered`);
    }
    this.registry.set(def.key, def);
  }

  /**
   * Retrieve a connector definition.
   */
  get(connectorKey: string): ConnectorDefinition | null {
    return this.registry.get(connectorKey) ?? null;
  }

  /**
   * Execute a connector safely.
   */
  async execute(ctx: ConnectorExecutionContext): Promise<ConnectorOutput> {
    const def = this.get(ctx.connectorKey);

    if (!def) {
      return {
        success: false,
        errorCode: "connector.not_found",
        errorMessage: `Connector '${ctx.connectorKey}' is not registered`,
      };
    }

    try {
      const output = await def.handler(ctx.payload ?? {});
      return {
        success: true,
        output,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errorCode: this.classifyError(message),
        errorMessage: message,
      };
    }
  }

  /**
   * Classify connector errors into structured error codes.
   */
  private classifyError(message: string): string {
    if (message.includes("timeout")) return "connector.timeout";
    if (message.includes("invalid")) return "connector.invalid_input";
    if (message.includes("auth")) return "connector.auth_failed";
    return "connector.execution_failed";
  }

  /**
   * Register built-in connectors.
   * (These can be replaced or extended later.)
   */
  registerBuiltIns() {
    this.register({
      key: "echo",
      name: "Echo Connector",
      description: "Returns the payload unchanged",
      handler: async (payload) => ({
        echo: payload,
        executedAt: new Date().toISOString(),
      }),
    });

    this.register({
      key: "math.add",
      name: "Math Add",
      description: "Adds two numbers",
      handler: async (payload) => {
        const a = Number(payload.a);
        const b = Number(payload.b);
        if (isNaN(a) || isNaN(b)) {
          throw new Error("invalid numbers");
        }
        return {
          a,
          b,
          result: a + b,
          executedAt: new Date().toISOString(),
        };
      },
    });

    this.register({
      key: "http.get",
      name: "HTTP GET",
      description: "Fetches a URL and returns the response body",
      handler: async (payload) => {
        const url = String(payload.url ?? "");
        if (!url) throw new Error("invalid url");

        const res = await fetch(url);
        const text = await res.text();

        return {
          url,
          status: res.status,
          body: text,
          executedAt: new Date().toISOString(),
        };
      },
    });
  }
}
