import { create } from "zustand";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

type JsonRecord = Record<string, Json | undefined>;
type WfValidation = { ok: boolean; errors?: string[]; warnings?: string[] } | null;
type WfMigration = {
  id: string;
  definition_id: string;
  strategy: string;
  state: string;
  started_at: string;
};
type WorkflowInvokeResult = Record<string, unknown> & {
  error?: string;
  version_id?: string | null;
  definition_id?: string | null;
  migration_id?: string | null;
};

export type WfNode = {
  id: string;
  type: "start" | "end" | "connector" | "approval" | "rollback" | "trigger" | "ai" | "branch" | "parallel" | "task";
  label: string;
  position: { x: number; y: number };
  config?: JsonRecord;
  retry?: { max: number; backoff_ms: number };
};
export type WfEdge = { id: string; from: string; to: string; condition?: string };
export type WfGraph = { nodes: WfNode[]; edges: WfEdge[] };

export type WfDefinition = {
  id: string; tenant_id: string; key: string; name: string;
  state: string; latest_version: number; created_at: string; updated_at: string;
};
export type WfVersion = {
  id: string; definition_id: string; tenant_id: string; version: number;
  state: "draft" | "published" | "archived" | "deprecated";
  graph: WfGraph; metadata: JsonRecord; validation: WfValidation;
  created_at: string; published_at: string | null; parent_version_id: string | null;
};
export type ConnectorSchema = {
  connector: string; version: number; capabilities: string[];
  input_schema: Json; output_schema: Json; description: string;
};

interface State {
  definitions: WfDefinition[];
  versions: WfVersion[];
  publishedMap: Record<string, string>; // definition_id -> version_id
  migrations: WfMigration[];
  schemas: ConnectorSchema[];
  selectedDefinitionId: string | null;
  selectedVersionId: string | null;
  draftGraph: WfGraph | null;
  dirty: boolean;
  loading: boolean;
  load: () => Promise<void>;
  selectDefinition: (id: string) => void;
  selectVersion: (id: string) => void;
  setDraftGraph: (g: WfGraph) => void;
  saveDraft: () => Promise<void>;
  validate: () => Promise<WorkflowInvokeResult | null>;
  publish: () => Promise<WorkflowInvokeResult | null>;
  archive: (versionId: string) => Promise<void>;
  rollback: (definitionId: string, targetVersionId: string) => Promise<void>;
  createDraftFromVersion: (versionId: string) => Promise<string | null>;
  createDefinition: (tenantId: string, key: string, name: string) => Promise<string | null>;
  startMigration: (definitionId: string, from: string, to: string, strategy?: string) => Promise<string | null>;
}

async function invoke(action: string, body: Record<string, unknown>): Promise<WorkflowInvokeResult> {
  const { data, error } = await supabase.functions.invoke("workflow-publish", {
    body: { action, ...body },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return (data ?? {}) as WorkflowInvokeResult;
}

export const useWorkflowStudio = create<State>((set, get) => ({
  definitions: [], versions: [], publishedMap: {}, migrations: [], schemas: [],
  selectedDefinitionId: null, selectedVersionId: null,
  draftGraph: null, dirty: false, loading: false,

  load: async () => {
    set({ loading: true });
    const [defs, vers, pub, migs, sch] = await Promise.all([
      supabase.from("workflow_definitions").select("*").order("updated_at", { ascending: false }),
      supabase.from("workflow_versions").select("*").order("version", { ascending: false }),
      supabase.from("workflow_published_versions").select("*"),
      supabase.from("workflow_migrations").select("*").order("started_at", { ascending: false }).limit(50),
      supabase.from("connector_schemas").select("*").order("connector", { ascending: true }),
    ]);
    const publishedMap: Record<string, string> = {};
    (pub.data ?? []).forEach((r) => { publishedMap[r.definition_id] = r.version_id; });
    set({
      definitions: (defs.data ?? []) as WfDefinition[],
      versions: (vers.data ?? []) as WfVersion[],
      publishedMap,
      migrations: (migs.data ?? []) as WfMigration[],
      schemas: (sch.data ?? []) as ConnectorSchema[],
      loading: false,
    });
    const st = get();
    if (!st.selectedDefinitionId && st.definitions.length) {
      st.selectDefinition(st.definitions[0].id);
    }
  },

  selectDefinition: (id) => {
    const versions = get().versions.filter((v) => v.definition_id === id);
    const latest = versions[0] ?? null;
    set({ selectedDefinitionId: id, selectedVersionId: latest?.id ?? null,
          draftGraph: latest?.graph ?? null, dirty: false });
  },

  selectVersion: (id) => {
    const v = get().versions.find((x) => x.id === id);
    set({ selectedVersionId: id, draftGraph: v?.graph ?? null, dirty: false });
  },

  setDraftGraph: (g) => set({ draftGraph: g, dirty: true }),

  saveDraft: async () => {
    const { selectedVersionId, draftGraph } = get();
    if (!selectedVersionId || !draftGraph) return;
    await invoke("save_draft", { version_id: selectedVersionId, graph: draftGraph });
    set({ dirty: false });
    await get().load();
  },

  validate: async () => {
    const { selectedVersionId } = get();
    if (!selectedVersionId) return null;
    const res = await invoke("validate", { version_id: selectedVersionId });
    await get().load();
    return res;
  },

  publish: async () => {
    const { selectedVersionId } = get();
    if (!selectedVersionId) return null;
    const res = await invoke("publish", { version_id: selectedVersionId });
    await get().load();
    return res;
  },

  archive: async (versionId) => {
    await invoke("archive", { version_id: versionId });
    await get().load();
  },

  rollback: async (definitionId, targetVersionId) => {
    await invoke("rollback", { definition_id: definitionId, target_version_id: targetVersionId });
    await get().load();
  },

  createDraftFromVersion: async (versionId) => {
    const res = await invoke("create_draft_from_version", { source_version_id: versionId });
    await get().load();
    const newId = res?.version_id ?? null;
    if (newId) set({ selectedVersionId: newId });
    return newId;
  },

  createDefinition: async (tenantId, key, name) => {
    const res = await invoke("create_definition", { tenant_id: tenantId, key, name });
    await get().load();
    const id = res?.definition_id ?? null;
    if (id) get().selectDefinition(id);
    return id;
  },

  startMigration: async (definitionId, from, to, strategy = "drain") => {
    const res = await invoke("start_migration", {
      definition_id: definitionId, from_version_id: from, to_version_id: to, strategy,
    });
    await get().load();
    return res?.migration_id ?? null;
  },
}));
