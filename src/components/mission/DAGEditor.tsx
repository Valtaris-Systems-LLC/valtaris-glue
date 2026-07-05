import { useEffect, useMemo, useRef, useState, useCallback, MouseEvent } from "react";
import { useWorkflowStudio, type ConnectorSchema, type WfNode, type WfEdge, type WfGraph } from "@/store/useWorkflowStudio";
import type { Json } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Trash2, Save, ShieldCheck, GitBranch, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

const NODE_TYPES: WfNode["type"][] = ["start", "end", "connector", "approval", "rollback", "trigger", "ai", "branch", "parallel", "task"];
const TYPE_COLOR: Record<string, string> = {
  start: "border-emerald-500/60 bg-emerald-500/10",
  end: "border-rose-500/60 bg-rose-500/10",
  connector: "border-sky-500/60 bg-sky-500/10",
  approval: "border-amber-500/60 bg-amber-500/10",
  rollback: "border-orange-500/60 bg-orange-500/10",
  trigger: "border-violet-500/60 bg-violet-500/10",
  ai: "border-fuchsia-500/60 bg-fuchsia-500/10",
  branch: "border-cyan-500/60 bg-cyan-500/10",
  parallel: "border-indigo-500/60 bg-indigo-500/10",
  task: "border-muted-foreground/40 bg-muted/30",
};

export function DAGEditor() {
  const draftGraph = useWorkflowStudio((s) => s.draftGraph);
  const setDraftGraph = useWorkflowStudio((s) => s.setDraftGraph);
  const selectedVersionId = useWorkflowStudio((s) => s.selectedVersionId);
  const versions = useWorkflowStudio((s) => s.versions);
  const schemas = useWorkflowStudio((s) => s.schemas);
  const dirty = useWorkflowStudio((s) => s.dirty);
  const save = useWorkflowStudio((s) => s.saveDraft);
  const validate = useWorkflowStudio((s) => s.validate);
  const publish = useWorkflowStudio((s) => s.publish);

  const version = versions.find((v) => v.id === selectedVersionId);
  const isDraft = version?.state === "draft";

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeFrom, setEdgeFrom] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; offX: number; offY: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const graph = useMemo<WfGraph>(() => draftGraph ?? { nodes: [], edges: [] }, [draftGraph]);
  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId) ?? null;

  const updateGraph = useCallback(
    (mut: (g: WfGraph) => WfGraph) => setDraftGraph(mut(graph)),
    [graph, setDraftGraph],
  );

  const addNode = (type: WfNode["type"]) => {
    if (!isDraft) return;
    const id = `${type}_${Math.random().toString(36).slice(2, 7)}`;
    const node: WfNode = {
      id, type, label: type, position: { x: 80 + Math.random() * 280, y: 80 + Math.random() * 180 },
      config: type === "connector" ? { connector: "stripe", action: "charge" } : {},
      retry: type === "connector" || type === "task" ? { max: 3, backoff_ms: 1000 } : undefined,
    };
    updateGraph((g) => ({ ...g, nodes: [...g.nodes, node] }));
    setSelectedNodeId(id);
  };

  const onNodeMouseDown = (e: MouseEvent, id: string) => {
    if (!isDraft) { setSelectedNodeId(id); return; }
    e.stopPropagation();
    const node = graph.nodes.find((n) => n.id === id)!;
    dragRef.current = { id, offX: e.clientX - node.position.x, offY: e.clientY - node.position.y };
    setSelectedNodeId(id); setSelectedEdgeId(null);
  };

  useEffect(() => {
    const onMove = (ev: globalThis.MouseEvent) => {
      const d = dragRef.current; if (!d) return;
      updateGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => n.id === d.id
          ? { ...n, position: { x: Math.max(0, ev.clientX - d.offX), y: Math.max(0, ev.clientY - d.offY) } }
          : n),
      }));
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [updateGraph]);

  const startEdge = (fromId: string) => { if (isDraft) setEdgeFrom(fromId); };
  const endEdge = (toId: string) => {
    if (!isDraft || !edgeFrom || edgeFrom === toId) { setEdgeFrom(null); return; }
    const id = `e_${edgeFrom}_${toId}`;
    if (graph.edges.some((e) => e.from === edgeFrom && e.to === toId)) { setEdgeFrom(null); return; }
    updateGraph((g) => ({ ...g, edges: [...g.edges, { id, from: edgeFrom!, to: toId }] }));
    setEdgeFrom(null);
  };

  const deleteNode = (id: string) => {
    if (!isDraft) return;
    updateGraph((g) => ({
      nodes: g.nodes.filter((n) => n.id !== id),
      edges: g.edges.filter((e) => e.from !== id && e.to !== id),
    }));
    setSelectedNodeId(null);
  };
  const deleteEdge = (id: string) => {
    if (!isDraft) return;
    updateGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }));
    setSelectedEdgeId(null);
  };

  const updateNode = (id: string, patch: Partial<WfNode>) => {
    updateGraph((g) => ({ ...g, nodes: g.nodes.map((n) => n.id === id ? { ...n, ...patch } : n) }));
  };
  const updateNodeConfig = (id: string, patch: Record<string, Json | undefined>) => {
    updateGraph((g) => ({ ...g, nodes: g.nodes.map((n) => n.id === id ? { ...n, config: { ...(n.config ?? {}), ...patch } } : n) }));
  };

  const handleSave = async () => {
    try {
      await save();
      toast.success("Draft saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save draft");
    }
  };
  const handleValidate = async () => {
    try {
      const result = await validate();
      if (result?.ok) {
        toast.success("Validation passed");
      } else {
        const errors = Array.isArray(result?.errors) ? result.errors : [];
        toast.error(`Validation failed: ${errors.length} errors`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Validation failed");
    }
  };
  const handlePublish = async () => {
    try {
      await publish();
      toast.success("Workflow published — version frozen");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Publish failed");
    }
  };

  if (!version) return <div className="p-8 text-sm text-muted-foreground">Select a workflow definition to begin authoring.</div>;

  return (
    <div className="grid grid-cols-12 gap-4">
      {/* Palette */}
      <Card className="col-span-2">
        <CardHeader className="py-3"><CardTitle className="text-xs uppercase tracking-wide">Nodes</CardTitle></CardHeader>
        <CardContent className="space-y-1.5 pt-0">
          {NODE_TYPES.map((t) => (
            <Button key={t} size="sm" variant="outline" className="w-full justify-start text-xs"
              disabled={!isDraft} onClick={() => addNode(t)}>
              <Plus className="h-3 w-3 mr-1" /> {t}
            </Button>
          ))}
          <div className="pt-3 text-[10px] text-muted-foreground leading-tight">
            {isDraft ? "Drag nodes to position. Click a node's halo handle then another node to wire." : "Published versions are read-only."}
          </div>
        </CardContent>
      </Card>

      {/* Canvas */}
      <Card className="col-span-7">
        <CardHeader className="py-3 flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-xs uppercase tracking-wide">DAG · v{version.version}</CardTitle>
            <Badge variant={isDraft ? "secondary" : "default"} className="text-[10px]">{version.state}</Badge>
            {dirty && <Badge variant="destructive" className="text-[10px]">unsaved</Badge>}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDraft || !dirty}><Save className="h-3 w-3 mr-1" />Save</Button>
            <Button size="sm" variant="outline" onClick={handleValidate}><ShieldCheck className="h-3 w-3 mr-1" />Validate</Button>
            <Button size="sm" onClick={handlePublish} disabled={!isDraft}><GitBranch className="h-3 w-3 mr-1" />Publish</Button>
          </div>
        </CardHeader>
        <CardContent>
          <div ref={canvasRef}
            className="relative h-[520px] bg-muted/20 rounded-md border border-dashed overflow-hidden"
            onClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); setEdgeFrom(null); }}>
            <svg className="absolute inset-0 w-full h-full pointer-events-none">
              <defs>
                <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" fill="hsl(var(--muted-foreground))" />
                </marker>
              </defs>
              {graph.edges.map((e) => {
                const a = graph.nodes.find((n) => n.id === e.from); const b = graph.nodes.find((n) => n.id === e.to);
                if (!a || !b) return null;
                const x1 = a.position.x + 80, y1 = a.position.y + 24, x2 = b.position.x, y2 = b.position.y + 24;
                return (
                  <g key={e.id} className="pointer-events-auto cursor-pointer"
                    onClick={(ev) => { ev.stopPropagation(); setSelectedEdgeId(e.id); }}>
                    <path d={`M${x1},${y1} C${x1+40},${y1} ${x2-40},${y2} ${x2},${y2}`}
                      fill="none" strokeWidth={selectedEdgeId === e.id ? 2.5 : 1.5}
                      stroke={selectedEdgeId === e.id ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))"}
                      markerEnd="url(#arr)" />
                  </g>
                );
              })}
            </svg>
            {graph.nodes.map((n) => (
              <div key={n.id}
                onMouseDown={(e) => onNodeMouseDown(e, n.id)}
                onClick={(e) => { e.stopPropagation(); if (edgeFrom) endEdge(n.id); else setSelectedNodeId(n.id); }}
                className={`absolute select-none rounded-md border-2 px-3 py-1.5 w-[160px] cursor-move text-xs ${TYPE_COLOR[n.type]} ${selectedNodeId === n.id ? "ring-2 ring-primary" : ""}`}
                style={{ left: n.position.x, top: n.position.y }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase opacity-70">{n.type}</span>
                  {isDraft && (
                    <button className="text-[10px] hover:text-primary"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (edgeFrom === n.id) setEdgeFrom(null);
                        else startEdge(n.id);
                      }}>
                      {edgeFrom === n.id ? "•cancel" : "→wire"}
                    </button>
                  )}
                </div>
                <div className="font-medium truncate">{n.label}</div>
                {n.config?.connector && <div className="text-[10px] opacity-70 font-mono">{n.config.connector}{n.config.action ? `.${n.config.action}` : ""}</div>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Inspector */}
      <Card className="col-span-3">
        <CardHeader className="py-3"><CardTitle className="text-xs uppercase tracking-wide">Inspector</CardTitle></CardHeader>
        <CardContent className="pt-0">
          <ScrollArea className="h-[500px] pr-2">
            {selectedNode ? (
              <NodeInspector node={selectedNode} schemas={schemas} disabled={!isDraft}
                onUpdate={(p) => updateNode(selectedNode.id, p)}
                onUpdateConfig={(p) => updateNodeConfig(selectedNode.id, p)}
                onDelete={() => deleteNode(selectedNode.id)} />
            ) : selectedEdgeId ? (
              <EdgeInspector edge={graph.edges.find((e) => e.id === selectedEdgeId)!} disabled={!isDraft}
                onUpdate={(p) => updateGraph((g) => ({ ...g, edges: g.edges.map((e) => e.id === selectedEdgeId ? { ...e, ...p } : e) }))}
                onDelete={() => deleteEdge(selectedEdgeId)} />
            ) : (
              <ValidationView />
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

type NodeInspectorProps = {
  node: WfNode;
  schemas: ConnectorSchema[];
  disabled: boolean;
  onUpdate: (patch: Partial<WfNode>) => void;
  onUpdateConfig: (patch: Record<string, Json | undefined>) => void;
  onDelete: () => void;
};

function NodeInspector({ node, schemas, disabled, onUpdate, onUpdateConfig, onDelete }: NodeInspectorProps) {
  const schema = schemas.find((s) => s.connector === node.config?.connector);
  return (
    <div className="space-y-3 text-xs">
      <div>
        <Label className="text-[10px] uppercase">Node ID</Label>
        <div className="font-mono text-[11px] text-muted-foreground">{node.id}</div>
      </div>
      <div>
        <Label className="text-[10px] uppercase">Label</Label>
        <Input value={node.label} disabled={disabled} onChange={(e) => onUpdate({ label: e.target.value })} className="h-7 text-xs" />
      </div>
      <div>
        <Label className="text-[10px] uppercase">Type</Label>
        <div className="font-mono text-[11px]">{node.type}</div>
      </div>
      {node.type === "connector" && (
        <>
          <div>
            <Label className="text-[10px] uppercase">Connector</Label>
            <Select value={node.config?.connector ?? ""} disabled={disabled} onValueChange={(v) => onUpdateConfig({ connector: v, action: undefined })}>
              <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="select" /></SelectTrigger>
              <SelectContent>
                {schemas.map((s) => <SelectItem key={s.connector} value={s.connector}>{s.connector}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {schema && (
            <div>
              <Label className="text-[10px] uppercase">Action</Label>
              <Select value={node.config?.action ?? ""} disabled={disabled} onValueChange={(v) => onUpdateConfig({ action: v })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="action" /></SelectTrigger>
                <SelectContent>
                  {(schema.capabilities ?? []).map((c: string) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="text-[10px] text-muted-foreground mt-1">schema v{schema.version}</div>
            </div>
          )}
        </>
      )}
      {node.type === "approval" && (
        <div>
          <Label className="text-[10px] uppercase">Required Role</Label>
          <Input value={node.config?.role ?? ""} disabled={disabled} onChange={(e) => onUpdateConfig({ role: e.target.value })} className="h-7 text-xs" placeholder="ops_lead" />
        </div>
      )}
      {node.type === "rollback" && (
        <div>
          <Label className="text-[10px] uppercase">Target Node</Label>
          <Input value={node.config?.target ?? ""} disabled={disabled} onChange={(e) => onUpdateConfig({ target: e.target.value })} className="h-7 text-xs" placeholder="node id to compensate" />
        </div>
      )}
      {node.retry !== undefined && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[10px] uppercase">Max Retries</Label>
            <Input type="number" value={node.retry?.max ?? 3} disabled={disabled}
              onChange={(e) => onUpdate({ retry: { ...(node.retry ?? {}), max: Number(e.target.value) } })} className="h-7 text-xs" />
          </div>
          <div>
            <Label className="text-[10px] uppercase">Backoff ms</Label>
            <Input type="number" value={node.retry?.backoff_ms ?? 1000} disabled={disabled}
              onChange={(e) => onUpdate({ retry: { ...(node.retry ?? {}), backoff_ms: Number(e.target.value) } })} className="h-7 text-xs" />
          </div>
        </div>
      )}
      <div>
        <Label className="text-[10px] uppercase">Raw Config (JSON)</Label>
        <Textarea rows={4} disabled={disabled} value={JSON.stringify(node.config ?? {}, null, 2)}
          onChange={(e) => {
            try {
              onUpdate({ config: JSON.parse(e.target.value) as Record<string, Json | undefined> });
            } catch {
              // ignore invalid JSON while typing
            }
          }}
          className="text-[10px] font-mono" />
      </div>
      <Button size="sm" variant="destructive" disabled={disabled} onClick={onDelete} className="w-full">
        <Trash2 className="h-3 w-3 mr-1" /> Delete node
      </Button>
    </div>
  );
}

type EdgeInspectorProps = {
  edge: WfEdge;
  disabled: boolean;
  onUpdate: (patch: Partial<WfEdge>) => void;
  onDelete: () => void;
};

function EdgeInspector({ edge, disabled, onUpdate, onDelete }: EdgeInspectorProps) {
  return (
    <div className="space-y-3 text-xs">
      <div className="font-mono text-[11px] text-muted-foreground">{edge.from} → {edge.to}</div>
      <div>
        <Label className="text-[10px] uppercase">Condition (optional)</Label>
        <Input value={edge.condition ?? ""} disabled={disabled} placeholder="e.g. result.status == 'ok'"
          onChange={(e) => onUpdate({ condition: e.target.value || undefined })} className="h-7 text-xs" />
      </div>
      <Button size="sm" variant="destructive" disabled={disabled} onClick={onDelete} className="w-full">
        <Trash2 className="h-3 w-3 mr-1" /> Delete edge
      </Button>
    </div>
  );
}

function ValidationView() {
  const selectedVersionId = useWorkflowStudio((s) => s.selectedVersionId);
  const v = useWorkflowStudio((s) => s.versions.find((x) => x.id === selectedVersionId));
  const val = v?.validation;
  if (!val) return <div className="text-xs text-muted-foreground">Run validation to see diagnostics.</div>;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        {val.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
        <span className="font-medium">{val.ok ? "Valid" : "Invalid"}</span>
      </div>
      {(val.errors ?? []).length > 0 && (
        <div>
          <div className="text-[10px] uppercase text-destructive">Errors</div>
          {val.errors.map((e: string, i: number) => <div key={i} className="font-mono text-[11px]">• {e}</div>)}
        </div>
      )}
      {(val.warnings ?? []).length > 0 && (
        <div>
          <div className="text-[10px] uppercase text-amber-500">Warnings</div>
          {val.warnings.map((w: string, i: number) => <div key={i} className="font-mono text-[11px]">• {w}</div>)}
        </div>
      )}
    </div>
  );
}
