// DAG execution helpers.
//
// This module is intentionally pure:
//   - no database access
//   - no network access
//   - no runtime/environment dependencies
//
// The workflow version graph is immutable at execution time.
// These helpers therefore enforce the structural assumptions that
// the worker relies upon when determining readiness and terminal state.

export interface DagNode {
  id: string;
  name: string;
  connector: string;
  dependsOn?: string[];
  parallel?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  approvalRequired?: boolean;
  onError?: "retry" | "fail" | "compensate" | "escalate";
  rollbackCheckpoint?: string;
}

export interface DagGraph {
  nodes: DagNode[];
}

export type NodeState =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface DagValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate the structural integrity of a workflow graph.
 *
 * This does not validate connector-specific configuration.
 * It only verifies that the graph itself is executable as a DAG.
 */
export function validateDagGraph(
  graph: DagGraph,
): DagValidationResult {
  const errors: string[] = [];

  if (
    !graph ||
    !Array.isArray(graph.nodes)
  ) {
    return {
      ok: false,
      errors: [
        "workflow graph must contain a nodes array",
      ],
    };
  }

  if (graph.nodes.length === 0) {
    return {
      ok: false,
      errors: [
        "workflow graph contains no nodes",
      ],
    };
  }

  const nodeIds =
    new Set<string>();

  /*
   * ------------------------------------------------------------
   * 1. Validate node identities.
   * ------------------------------------------------------------
   */

  for (
    const node of graph.nodes
  ) {
    if (
      !node ||
      typeof node !== "object"
    ) {
      errors.push(
        "workflow graph contains an invalid node",
      );
      continue;
    }

    if (
      typeof node.id !==
        "string" ||
      node.id.trim().length === 0
    ) {
      errors.push(
        "workflow graph contains a node without a valid id",
      );
      continue;
    }

    const id =
      node.id.trim();

    if (
      nodeIds.has(id)
    ) {
      errors.push(
        `workflow graph contains duplicate node id: ${id}`,
      );
    }

    nodeIds.add(id);

    if (
      typeof node.name !==
        "string" ||
      node.name.trim().length === 0
    ) {
      errors.push(
        `node ${id} has no valid name`,
      );
    }

    if (
      typeof node.connector !==
        "string" ||
      node.connector.trim().length === 0
    ) {
      errors.push(
        `node ${id} has no valid connector`,
      );
    }
  }

  /*
   * ------------------------------------------------------------
   * 2. Validate dependency references.
   * ------------------------------------------------------------
   */

  for (
    const node of graph.nodes
  ) {
    if (
      !node ||
      typeof node.id !==
        "string"
    ) {
      continue;
    }

    const nodeId =
      node.id.trim();

    const dependencies =
      node.dependsOn ??
      [];

    if (
      !Array.isArray(
        dependencies,
      )
    ) {
      errors.push(
        `node ${nodeId} has an invalid dependsOn value`,
      );
      continue;
    }

    const dependencyIds =
      new Set<string>();

    for (
      const dependency of
        dependencies
    ) {
      if (
        typeof dependency !==
          "string" ||
        dependency.trim()
          .length === 0
      ) {
        errors.push(
          `node ${nodeId} contains an invalid dependency reference`,
        );
        continue;
      }

      const dependencyId =
        dependency.trim();

      if (
        dependencyIds.has(
          dependencyId,
        )
      ) {
        errors.push(
          `node ${nodeId} contains duplicate dependency ${dependencyId}`,
        );
      }

      dependencyIds.add(
        dependencyId,
      );

      if (
        !nodeIds.has(
          dependencyId,
        )
      ) {
        errors.push(
          `node ${nodeId} references missing dependency ${dependencyId}`,
        );
      }

      if (
        dependencyId ===
        nodeId
      ) {
        errors.push(
          `node ${nodeId} cannot depend on itself`,
        );
      }
    }
  }

  /*
   * ------------------------------------------------------------
   * 3. Detect dependency cycles.
   *
   * A cycle can otherwise leave the worker with permanently pending
   * nodes that can never become ready.
   * ------------------------------------------------------------
   */

  if (
    errors.length === 0 &&
    hasCycle(graph)
  ) {
    errors.push(
      "workflow graph contains a dependency cycle",
    );
  }

  return {
    ok:
      errors.length === 0,
    errors,
  };
}

/**
 * Return nodes whose dependencies are all completed and which
 * have not started yet.
 *
 * A node with no dependencies is immediately eligible.
 *
 * Missing dependency state is deliberately treated as unresolved,
 * rather than completed. This prevents malformed state maps from
 * accidentally releasing a node.
 */
export function readyNodes(
  graph: DagGraph,
  states: Record<
    string,
    NodeState
  >,
): DagNode[] {
  return graph.nodes.filter(
    (node) => {
      const state =
        states[node.id] ??
        "pending";

      if (
        state !==
        "pending"
      ) {
        return false;
      }

      const dependencies =
        node.dependsOn ??
        [];

      return dependencies.every(
        (dependencyId) =>
          states[
            dependencyId
          ] === "completed",
      );
    },
  );
}

/**
 * Determine whether the workflow has reached a terminal state.
 *
 * Rules:
 *
 *   completed/skipped only
 *      → successful terminal state
 *
 *   failed + no queued/running work
 *      → failed terminal state
 *
 *   queued/running work remains
 *      → not terminal
 *
 * Pending nodes following a failed dependency do not prevent
 * terminal failure. They are unreachable and must not keep a failed
 * workflow alive forever.
 */
export function isTerminal(
  graph: DagGraph,
  states: Record<
    string,
    NodeState
  >,
): {
  done: boolean;
  failed: boolean;
} {
  const ids =
    graph.nodes.map(
      (node) =>
        node.id,
    );

  const anyFailed =
    ids.some(
      (id) =>
        states[id] ===
        "failed",
    );

  if (
    anyFailed
  ) {
    const active =
      ids.some(
        (id) => {
          const state =
            states[id] ??
            "pending";

          return (
            state ===
              "queued" ||
            state ===
              "running"
          );
        },
      );

    return {
      done:
        !active,
      failed:
        true,
    };
  }

  const allDone =
    ids.every(
      (id) => {
        const state =
          states[id] ??
          "pending";

        return (
          state ===
            "completed" ||
          state ===
            "skipped"
        );
      },
    );

  return {
    done:
      allDone,
    failed:
      false,
  };
}

/**
 * Resolve a node by its immutable graph ID.
 */
export function nodeById(
  graph: DagGraph,
  id: string,
): DagNode | undefined {
  return graph.nodes.find(
    (node) =>
      node.id === id,
  );
}

/**
 * Return root nodes.
 *
 * A root is a node without dependencies.
 */
export function rootNodes(
  graph: DagGraph,
): DagNode[] {
  return graph.nodes.filter(
    (node) =>
      !node.dependsOn ||
      node.dependsOn.length ===
        0,
  );
}

/**
 * Determine whether the graph contains a dependency cycle.
 *
 * Uses DFS with three states:
 *
 *   0 = unseen
 *   1 = currently visiting
 *   2 = completely visited
 *
 * Encountering a node currently being visited means there is
 * a directed cycle.
 */
function hasCycle(
  graph: DagGraph,
): boolean {
  const dependencies =
    new Map<
      string,
      string[]
    >();

  for (
    const node of
      graph.nodes
  ) {
    dependencies.set(
      node.id,
      node.dependsOn ??
        [],
    );
  }

  const visiting =
    new Set<string>();

  const visited =
    new Set<string>();

  function visit(
    nodeId: string,
  ): boolean {
    if (
      visiting.has(
        nodeId,
      )
    ) {
      return true;
    }

    if (
      visited.has(
        nodeId,
      )
    ) {
      return false;
    }

    visiting.add(
      nodeId,
    );

    const deps =
      dependencies.get(
        nodeId,
      ) ?? [];

    for (
      const dependencyId of
        deps
    ) {
      if (
        visit(
          dependencyId,
        )
      ) {
        return true;
      }
    }

    visiting.delete(
      nodeId,
    );

    visited.add(
      nodeId,
    );

    return false;
  }

  for (
    const node of
      graph.nodes
  ) {
    if (
      visit(
        node.id,
      )
    ) {
      return true;
    }
  }

  return false;
}
