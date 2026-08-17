// src/orchestration/connector-registry.ts
// Valtaris Glue — Connector Registry
//
// Provides:
// - registerConnector()
// - getConnector()
// - listConnectors()
// - ensures connectors are discoverable by TaskRunner

export type ConnectorFn = (
  payload: Record<string, unknown>
) => Promise<Record<string, unknown>>;

export class ConnectorRegistry {
  private connectors: Record<string, ConnectorFn> = {};

  registerConnector(stepId: string, fn: ConnectorFn) {
    if (this.connectors[stepId]) {
      throw new Error(
        `connector-registry.duplicate: connector for '${stepId}' already exists`
      );
    }
    this.connectors[stepId] = fn;
  }

  getConnector(stepId: string): ConnectorFn | null {
    return this.connectors[stepId] ?? null;
  }

  listConnectors(): string[] {
    return Object.keys(this.connectors);
  }
}
