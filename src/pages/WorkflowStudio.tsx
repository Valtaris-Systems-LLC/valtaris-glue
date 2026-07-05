import { useEffect, useState } from "react";
import { useWorkflowStudio, type WfMigration } from "@/store/useWorkflowStudio";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { DAGEditor } from "@/components/mission/DAGEditor";
import { WorkflowHealthPanel } from "@/components/mission/WorkflowHealthPanel";
import { Plus, GitBranch, History, AlertTriangle, RotateCcw, Archive, FileEdit, Workflow } from "lucide-react";
import { toast } from "sonner";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed";
}

export default function WorkflowStudio() {
  const { user } = useAuth();
  const load = useWorkflowStudio((s) => s.load);
  const definitions = useWorkflowStudio((s) => s.definitions);
  const versions = useWorkflowStudio((s) => s.versions);
  const publishedMap = useWorkflowStudio((s) => s.publishedMap);
  const selectedDefinitionId = useWorkflowStudio((s) => s.selectedDefinitionId);
  const selectedVersionId = useWorkflowStudio((s) => s.selectedVersionId);
  const selectDefinition = useWorkflowStudio((s) => s.selectDefinition);
  const selectVersion = useWorkflowStudio((s) => s.selectVersion);
  const createDefinition = useWorkflowStudio((s) => s.createDefinition);
  const createDraftFromVersion = useWorkflowStudio((s) => s.createDraftFromVersion);
  const rollback = useWorkflowStudio((s) => s.rollback);
  const archive = useWorkflowStudio((s) => s.archive);
  const migrations = useWorkflowStudio((s) => s.migrations);
  const startMigration = useWorkflowStudio((s) => s.startMigration);

  useEffect(() => { void load(); }, [load]);

  const def = definitions.find((d) => d.id === selectedDefinitionId);
  const defVersions = versions.filter((v) => v.definition_id === selectedDefinitionId);
  const publishedId = selectedDefinitionId ? publishedMap[selectedDefinitionId] : null;

  return (
    <div className="px-6 lg:px-8 py-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Workflow Studio"
        description="Author, validate, and version operational DAGs. Published versions are immutable; in-flight runs stay pinned to their original topology."
      />


      <div className="grid grid-cols-12 gap-4">
        <Card className="col-span-3">
          <CardHeader className="py-3 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-xs uppercase tracking-wide">Workflows</CardTitle>
            <NewDefinitionDialog onCreate={async (key, name) => {
              if (!user) { toast.error("Sign in required"); return; }
              const { data: m } = await supabase.from("tenant_members").select("tenant_id").eq("user_id", user.id).limit(1).maybeSingle();
              if (!m) { toast.error("No tenant membership"); return; }
              try { await createDefinition(m.tenant_id, key, name); toast.success("Workflow created"); }
              catch (e) { toast.error(getErrorMessage(e)); }
            }} />
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="h-[600px] pr-2">
              {definitions.length === 0 && <div className="text-xs text-muted-foreground py-4">No workflows yet. Create one to begin.</div>}
              {definitions.map((d) => {
                const pubId = publishedMap[d.id];
                const pubV = pubId ? versions.find((v) => v.id === pubId) : null;
                return (
                  <button key={d.id} onClick={() => selectDefinition(d.id)}
                    className={`w-full text-left px-2 py-2 rounded text-xs mb-1 ${selectedDefinitionId === d.id ? "bg-accent" : "hover:bg-accent/50"}`}>
                    <div className="font-medium truncate flex items-center gap-2">
                      <GitBranch className="h-3 w-3 shrink-0" />{d.name}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <Badge variant="outline" className="text-[9px] px-1 py-0">v{d.latest_version}</Badge>
                      {pubV && <Badge className="text-[9px] px-1 py-0">live v{pubV.version}</Badge>}
                      <span className="text-[10px] text-muted-foreground font-mono">{d.key}</span>
                    </div>
                  </button>
                );
              })}
            </ScrollArea>
          </CardContent>
        </Card>

        <div className="col-span-9 space-y-4">
          {def ? (
            <>
              <Card>
                <CardHeader className="py-3 flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="text-sm">{def.name}</CardTitle>
                    <div className="text-[11px] text-muted-foreground font-mono mt-0.5">{def.key} · latest v{def.latest_version}</div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-12 gap-3">
                    <div className="col-span-4">
                      <div className="text-[10px] uppercase text-muted-foreground mb-2 flex items-center gap-1.5">
                        <History className="h-3 w-3" /> Version history
                      </div>
                      <ScrollArea className="h-[140px]">
                        {defVersions.map((v) => (
                          <div key={v.id}
                            className={`flex items-center justify-between text-xs py-1 px-2 rounded cursor-pointer mb-0.5 ${selectedVersionId === v.id ? "bg-accent" : "hover:bg-accent/50"}`}
                            onClick={() => selectVersion(v.id)}>
                            <span className="font-mono">v{v.version}</span>
                            <div className="flex items-center gap-1">
                              {publishedId === v.id && <Badge className="text-[9px] px-1 py-0">live</Badge>}
                              <Badge variant="outline" className="text-[9px] px-1 py-0">{v.state}</Badge>
                              {v.validation?.ok === false && <AlertTriangle className="h-3 w-3 text-destructive" />}
                            </div>
                          </div>
                        ))}
                      </ScrollArea>
                    </div>
                    <div className="col-span-4 space-y-2">
                      <div className="text-[10px] uppercase text-muted-foreground mb-2">Lineage actions</div>
                      <Button size="sm" variant="outline" className="w-full justify-start text-xs"
                        disabled={!selectedVersionId}
                        onClick={async () => {
                          try { await createDraftFromVersion(selectedVersionId!); toast.success("Draft branched"); }
                          catch (e) { toast.error(getErrorMessage(e)); }
                        }}>
                        <FileEdit className="h-3 w-3 mr-1.5" />Branch as new draft
                      </Button>
                      <Button size="sm" variant="outline" className="w-full justify-start text-xs"
                        disabled={!selectedVersionId || publishedId === selectedVersionId || !publishedId}
                        onClick={async () => {
                          try { await rollback(def.id, selectedVersionId!); toast.success("Rolled back published pointer"); }
                          catch (e) { toast.error(getErrorMessage(e)); }
                        }}>
                        <RotateCcw className="h-3 w-3 mr-1.5" />Rollback to selected
                      </Button>
                      <Button size="sm" variant="outline" className="w-full justify-start text-xs"
                        disabled={!selectedVersionId || publishedId === selectedVersionId}
                        onClick={async () => {
                          try { await archive(selectedVersionId!); toast.success("Version archived"); }
                          catch (e) { toast.error(getErrorMessage(e)); }
                        }}>
                        <Archive className="h-3 w-3 mr-1.5" />Archive selected
                      </Button>
                      <Button size="sm" variant="outline" className="w-full justify-start text-xs"
                        disabled={!publishedId || !selectedVersionId || publishedId === selectedVersionId}
                        onClick={async () => {
                          try { await startMigration(def.id, publishedId!, selectedVersionId!, "drain"); toast.success("Drain migration started"); }
                          catch (e) { toast.error(getErrorMessage(e)); }
                        }}>
                        <GitBranch className="h-3 w-3 mr-1.5" />Start drain migration
                      </Button>
                    </div>
                    <div className="col-span-4">
                      <div className="text-[10px] uppercase text-muted-foreground mb-2">Recent migrations</div>
                      <ScrollArea className="h-[140px]">
                        {migrations.filter((m: WfMigration) => m.definition_id === def.id).slice(0, 8).map((m: WfMigration) => (
                          <div key={m.id} className="text-[11px] py-1 border-b border-border/50">
                            <div className="flex items-center justify-between">
                              <span className="font-mono">{m.strategy}</span>
                              <Badge variant="outline" className="text-[9px] px-1 py-0">{m.state}</Badge>
                            </div>
                            <div className="text-[10px] text-muted-foreground">{new Date(m.started_at).toLocaleString()}</div>
                          </div>
                        ))}
                        {migrations.filter((m: WfMigration) => m.definition_id === def.id).length === 0 && (
                          <div className="text-[11px] text-muted-foreground">No migrations recorded.</div>
                        )}
                      </ScrollArea>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <WorkflowHealthPanel />
              <DAGEditor />
            </>
          ) : (
            <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">
              Select or create a workflow to open the studio.
            </CardContent></Card>
          )}
        </div>
      </div>
    </div>
  );
}

function NewDefinitionDialog({ onCreate }: { onCreate: (key: string, name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs"><Plus className="h-3 w-3 mr-1" />New</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New workflow</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => { setName(e.target.value); if (!key) setKey(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_")); }} />
          </div>
          <div>
            <Label className="text-xs">Key (immutable)</Label>
            <Input value={key} onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} className="font-mono text-xs" />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!name || !key} onClick={async () => { await onCreate(key, name); setOpen(false); setName(""); setKey(""); }}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
