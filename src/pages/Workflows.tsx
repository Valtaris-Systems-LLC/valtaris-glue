import { useCallback, useEffect, useState } from 'react';
import { useApiStore, Workflow, WorkflowStep } from '@/store/useApiStore';
import type { Json } from '@/integrations/supabase/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Plus, Play, Trash2, CheckCircle, XCircle, Clock, GitBranch, ArrowDown, ChevronDown, History, Paperclip, Loader2, RotateCw, SkipForward } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { ExecutionGraph } from '@/components/mission/ExecutionGraph';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/hooks/use-toast';
import { toast as sonner } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

function StepEditor({ workflowId, step, index }: { workflowId: string; step: WorkflowStep; index: number }) {
  const updateData = useApiStore(s => s.updateWorkflowStepData);
  const updateRetry = useApiStore(s => s.updateWorkflowStepRetry);
  const removeStep = useApiStore(s => s.removeWorkflowStep);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(JSON.stringify(step.data, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputId = `file-${step.id}`;

  const handleBlur = () => {
    try {
      const parsed = text.trim() ? JSON.parse(text) : {};
      updateData(workflowId, step.id, parsed);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      sonner.error('File must be under 20MB');
      return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) { sonner.error('Sign in required'); return; }

    setUploading(true);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${userId}/${Date.now()}-${safeName}`;
    const { error: upErr } = await supabase.storage
      .from('workflow-files')
      .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });
    if (upErr) {
      sonner.error(upErr.message);
      setUploading(false);
      return;
    }
    // Generate a signed URL (7 days) so external APIs can fetch without the bucket being public
    const { data: signed, error: signErr } = await supabase
      .storage
      .from('workflow-files')
      .createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signErr || !signed?.signedUrl) {
      sonner.error(signErr?.message || 'Could not sign file URL');
      setUploading(false);
      return;
    }

    // Merge fileUrl into the step's JSON input. The runner mirrors these fields
    // onto context[i].output so downstream steps can use {{N.output.fileUrl}}.
    let current: Record<string, Json | undefined> = {};
    try { current = text.trim() ? JSON.parse(text) : {}; } catch { current = {}; }
    const next = {
      ...current,
      fileUrl: signed.signedUrl,
      filePath: path,
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
    };
    const nextText = JSON.stringify(next, null, 2);
    setText(nextText);
    updateData(workflowId, step.id, next);
    setErr(null);
    setUploading(false);
    sonner.success(`Uploaded — downstream: {{${index - 1}.output.fileUrl}}`);
  };

  return (
    <div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-3 p-2.5 rounded-md bg-muted/20 border border-border/30">
          <span className="text-[10px] font-mono text-muted-foreground w-5 shrink-0">#{index}</span>
          {step.status === 'success' && <CheckCircle className="h-3.5 w-3.5 text-primary shrink-0" />}
          {step.status === 'error' && <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
          {step.status === 'skipped' && <SkipForward className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          {step.status === 'pending' && <Clock className="h-3.5 w-3.5 text-accent animate-spin shrink-0" />}
          {step.status === 'idle' && <div className="h-3.5 w-3.5 rounded-full border border-border shrink-0" />}
          <span className="font-mono text-xs text-foreground flex-1">{step.service}.{step.action}</span>
          {step.data?.fileUrl && <Paperclip className="h-3 w-3 text-accent shrink-0" />}
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground">
              <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>
          <Button variant="ghost" size="icon" onClick={() => removeStep(workflowId, step.id)} className="h-6 w-6 text-muted-foreground hover:text-destructive">
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
        <CollapsibleContent className="pt-2 px-2">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] font-mono text-muted-foreground">
              Input JSON — reference earlier steps with <code className="text-accent">{'{{0.output.id}}'}</code>
            </p>
            <input id={fileInputId} type="file" className="hidden" onChange={handleFileUpload} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => document.getElementById(fileInputId)?.click()}
              disabled={uploading}
              className="h-6 px-2 text-[10px] font-mono"
            >
              {uploading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Paperclip className="h-3 w-3 mr-1" />}
              {uploading ? 'Uploading…' : 'Upload file'}
            </Button>
          </div>
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={handleBlur}
            rows={6}
            className="font-mono text-[11px] bg-muted/50 border-border/50"
            placeholder='{ "amount": 1000, "currency": "usd" }'
          />
          {err && <p className="text-[10px] font-mono text-destructive mt-1">JSON error: {err}</p>}
          {step.data?.fileUrl && (
            <p className="text-[10px] font-mono text-muted-foreground mt-1 truncate">
              📎 {step.data.fileName || 'file'} — downstream: <code className="text-accent">{`{{${index - 1}.output.fileUrl}}`}</code>
            </p>
          )}
          {step.result && (
            <details className="mt-2">
              <summary className="text-[10px] font-mono text-muted-foreground cursor-pointer">Last result</summary>
              <pre className="text-[10px] font-mono text-muted-foreground bg-muted/30 p-2 rounded mt-1 overflow-auto max-h-40">
                {JSON.stringify(step.result, null, 2)}
              </pre>
            </details>
          )}
          <div className="mt-2 grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-0.5">Max retries</label>
              <Input
                type="number" min={0} max={10}
                value={step.maxRetries ?? 0}
                onChange={e => updateRetry(workflowId, step.id, { maxRetries: Math.max(0, Number(e.target.value) || 0) })}
                className="h-7 font-mono text-[11px] bg-muted/50 border-border/50"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-0.5">Delay (ms)</label>
              <Input
                type="number" min={0} step={100}
                value={step.retryDelayMs ?? 500}
                onChange={e => updateRetry(workflowId, step.id, { retryDelayMs: Math.max(0, Number(e.target.value) || 0) })}
                className="h-7 font-mono text-[11px] bg-muted/50 border-border/50"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-0.5">On failure</label>
              <Select
                value={step.onError ?? 'stop'}
                onValueChange={(v: 'stop' | 'continue' | 'skip') => updateRetry(workflowId, step.id, { onError: v })}
              >
                <SelectTrigger className="h-7 font-mono text-[11px] bg-muted/50 border-border/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stop" className="font-mono text-xs">Stop run</SelectItem>
                  <SelectItem value="continue" className="font-mono text-xs">Continue</SelectItem>
                  <SelectItem value="skip" className="font-mono text-xs">Skip & continue</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground mt-1">
            Retries use exponential backoff. <span className="text-accent">Continue</span> marks run failed but proceeds; <span className="text-accent">Skip</span> ignores the error.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const connectedServices = useApiStore(s => s.connectedServices);
  const addWorkflowStep = useApiStore(s => s.addWorkflowStep);
  const runWorkflow = useApiStore(s => s.runWorkflow);
  const retryFromFailed = useApiStore(s => s.retryWorkflowFromFailed);
  const deleteWorkflow = useApiStore(s => s.deleteWorkflow);
  const loading = useApiStore(s => s.loading);
  const hasFailedStep = workflow.steps.some(s => s.status === 'error');

  const [stepService, setStepService] = useState('');
  const [stepAction, setStepAction] = useState('');

  const currentService = connectedServices.find(s => s.name === stepService);

  const handleAddStep = () => {
    if (!stepService || !stepAction) return;
    addWorkflowStep(workflow.id, { service: stepService, action: stepAction, data: {} });
    setStepService('');
    setStepAction('');
  };

  const handleRun = async () => {
    toast({ title: `Running "${workflow.name}"...` });
    await runWorkflow(workflow.id);
    toast({ title: `Workflow "${workflow.name}" finished` });
  };

  const statusColor = {
    idle: 'text-muted-foreground',
    running: 'text-accent',
    completed: 'text-primary',
    failed: 'text-destructive',
  };

  return (
    <div className="glass-panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-display font-semibold text-foreground">{workflow.name}</h3>
          <span className={`text-[10px] font-mono uppercase tracking-wider ${statusColor[workflow.status]}`}>
            {workflow.status}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {hasFailedStep && (
            <Button
              variant="outline" size="sm"
              onClick={async () => { toast({ title: `Resuming "${workflow.name}" from failed step…` }); await retryFromFailed(workflow.id); }}
              disabled={loading}
              className="text-xs font-mono"
            >
              <RotateCw className="h-3 w-3 mr-1" /> Resume
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleRun} disabled={workflow.steps.length === 0 || loading} className="text-xs font-mono">
            <Play className="h-3 w-3 mr-1" /> Run
          </Button>
          <Button variant="ghost" size="icon" onClick={() => deleteWorkflow(workflow.id)} className="h-8 w-8 text-muted-foreground hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        {workflow.steps.map((step, i) => (
          <div key={step.id}>
            <StepEditor workflowId={workflow.id} step={step} index={i + 1} />
            {i < workflow.steps.length - 1 && (
              <div className="flex justify-center py-1">
                <ArrowDown className="h-3 w-3 text-muted-foreground/50" />
              </div>
            )}
          </div>
        ))}
      </div>

      {connectedServices.length > 0 && (
        <div className="flex gap-2">
          <Select value={stepService} onValueChange={v => { setStepService(v); setStepAction(''); }}>
            <SelectTrigger className="h-8 font-mono text-xs bg-muted border-border/50 flex-1">
              <SelectValue placeholder="Service" />
            </SelectTrigger>
            <SelectContent>
              {connectedServices.map(s => (
                <SelectItem key={s.name} value={s.name} className="font-mono text-xs">{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={stepAction} onValueChange={setStepAction} disabled={!stepService}>
            <SelectTrigger className="h-8 font-mono text-xs bg-muted border-border/50 flex-1">
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              {(currentService?.actions || []).map(a => (
                <SelectItem key={a} value={a} className="font-mono text-xs">{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={handleAddStep} disabled={!stepService || !stepAction} className="h-8 text-xs font-mono">
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 20;

// Lightweight row used in the list — heavy `steps` JSON is fetched lazily on expand
interface RunRow {
  id: string;
  workflow_name: string;
  status: string;
  duration_ms: number | null;
  error: string | null;
  step_count: number | null;
  started_at: string;
  finished_at: string | null;
}

type RunStep = {
  status?: string;
  success?: boolean;
  service: string;
  action: string;
  attempts?: number;
  duration_ms?: number | null;
};

function RunHistory() {
  const { user } = useAuth();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'failed' | 'running'>('all');
  const [expandedSteps, setExpandedSteps] = useState<Record<string, RunStep[]>>({});

  // Build a base query with the active filter — selects only list-grade columns.
  // step_count uses jsonb_array_length so we don't pull the whole steps blob.
  const buildQuery = useCallback(() => {
    let q = supabase
      .from('workflow_runs')
      .select('id, workflow_name, status, duration_ms, error, started_at, finished_at, step_count:steps')
      .order('started_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (statusFilter !== 'all') q = q.eq('status', statusFilter);
    return q;
  }, [statusFilter]);

  // Map raw rows: replace the steps payload with its length so the list stays light.
  const mapRows = useCallback((rows: Array<RunRow & { step_count: Json | null }>): RunRow[] =>
    rows.map(r => ({
      ...r,
      step_count: Array.isArray(r.step_count) ? r.step_count.length : null,
    })), []);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setExpandedSteps({});
    const { data } = await buildQuery();
    const mapped = mapRows((data ?? []) as Array<RunRow & { step_count: Json | null }>);
    setRuns(mapped);
    setHasMore(mapped.length === PAGE_SIZE);
    setLoading(false);
  }, [buildQuery, mapRows, user]);

  // Keyset pagination using started_at as the cursor — fast even with many rows
  // thanks to the (user_id, started_at DESC) index.
  const loadMore = useCallback(async () => {
    if (!user || runs.length === 0) return;
    setLoadingMore(true);
    const cursor = runs[runs.length - 1].started_at;
    let q = supabase
      .from('workflow_runs')
      .select('id, workflow_name, status, duration_ms, error, started_at, finished_at, step_count:steps')
      .order('started_at', { ascending: false })
      .lt('started_at', cursor)
      .limit(PAGE_SIZE);
    if (statusFilter !== 'all') q = q.eq('status', statusFilter);
    const { data } = await q;
    const mapped = mapRows((data ?? []) as Array<RunRow & { step_count: Json | null }>);
    setRuns(prev => [...prev, ...mapped]);
    setHasMore(mapped.length === PAGE_SIZE);
    setLoadingMore(false);
  }, [mapRows, runs, statusFilter, user]);

  // Lazy-fetch the heavy steps payload when a row is expanded
  const fetchSteps = useCallback(async (runId: string) => {
    if (expandedSteps[runId]) return;
    const { data } = await supabase
      .from('workflow_runs')
      .select('steps')
      .eq('id', runId)
      .single();
    setExpandedSteps(prev => ({ ...prev, [runId]: Array.isArray(data?.steps) ? (data.steps as RunStep[]) : [] }));
  }, [expandedSteps]);

  useEffect(() => { void load(); }, [load]);

  const workflowsRunning = useApiStore(s => s.workflows.some(w => w.status === 'running'));
  useEffect(() => {
    if (!workflowsRunning) return;
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [load, workflowsRunning]);

  return (
    <div className="glass-panel p-5">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-display font-semibold text-foreground">Run History</h3>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={(v: 'all' | 'completed' | 'failed' | 'running') => setStatusFilter(v)}>
            <SelectTrigger className="h-7 w-[120px] font-mono text-[11px] bg-muted border-border/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-mono text-xs">All</SelectItem>
              <SelectItem value="completed" className="font-mono text-xs">Completed</SelectItem>
              <SelectItem value="failed" className="font-mono text-xs">Failed</SelectItem>
              <SelectItem value="running" className="font-mono text-xs">Running</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={load} className="text-xs font-mono h-7">Refresh</Button>
        </div>
      </div>
      {loading ? (
        <p className="text-xs font-mono text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-xs font-mono text-muted-foreground">No runs yet.</p>
      ) : (
        <>
          <div className="space-y-2">
            {runs.map(run => {
              const steps = expandedSteps[run.id];
              return (
                <details
                  key={run.id}
                  className="rounded-md bg-muted/20 border border-border/30"
                  onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) fetchSteps(run.id); }}
                >
                  <summary className="flex items-center gap-3 p-2.5 cursor-pointer">
                    {run.status === 'completed' && <CheckCircle className="h-3.5 w-3.5 text-primary" />}
                    {run.status === 'failed' && <XCircle className="h-3.5 w-3.5 text-destructive" />}
                    {run.status === 'running' && <Clock className="h-3.5 w-3.5 text-accent animate-spin" />}
                    <span className="font-mono text-xs flex-1 truncate">{run.workflow_name}</span>
                    {run.step_count != null && (
                      <span className="text-[10px] font-mono text-muted-foreground">{run.step_count} steps</span>
                    )}
                    {run.duration_ms != null && (
                      <span className="text-[10px] font-mono text-muted-foreground">{run.duration_ms}ms</span>
                    )}
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {new Date(run.started_at).toLocaleTimeString()}
                    </span>
                  </summary>
                  <div className="px-3 pb-3 space-y-1.5">
                    {run.error && (
                      <p className="text-[10px] font-mono text-destructive">Error: {run.error}</p>
                    )}
                    {steps === undefined ? (
                      <p className="text-[10px] font-mono text-muted-foreground">Loading steps…</p>
                    ) : steps.length === 0 ? (
                      <p className="text-[10px] font-mono text-muted-foreground">No step details.</p>
                    ) : (
                      steps.map((s, i: number) => (
                        <div key={i} className="text-[10px] font-mono">
                          <div className="flex items-center gap-2">
                            {s.status === 'skipped'
                              ? <SkipForward className="h-2.5 w-2.5 text-muted-foreground" />
                              : s.success
                                ? <CheckCircle className="h-2.5 w-2.5 text-primary" />
                                : <XCircle className="h-2.5 w-2.5 text-destructive" />}
                            <span>#{i + 1} {s.service}.{s.action}</span>
                            {s.attempts > 1 && <span className="text-accent">×{s.attempts}</span>}
                            {s.duration_ms != null && <span className="text-muted-foreground">({s.duration_ms}ms)</span>}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </details>
              );
            })}
          </div>
          {hasMore && (
            <div className="mt-3 flex justify-center">
              <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore} className="text-xs font-mono h-7">
                {loadingMore ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DemoWorkflowsSection() {
  const demoMode = useApiStore(s => s.demoMode);
  const demoWorkflows = useApiStore(s => s.demoWorkflows);
  if (!demoMode || demoWorkflows.length === 0) return null;

  const tone = (status: string): 'success' | 'danger' | 'info' | 'warning' =>
    status === 'succeeded' ? 'success'
    : status === 'failed' ? 'danger'
    : status === 'retrying' ? 'warning'
    : 'info';

  const segBg = (status: string) =>
    status === 'succeeded' ? 'bg-success'
    : status === 'failed' ? 'bg-danger'
    : status === 'retrying' ? 'bg-warning'
    : status === 'skipped' ? 'bg-muted-foreground/40'
    : 'bg-info';

  const accentBorder = (status: string) =>
    status === 'succeeded' ? 'border-l-success'
    : status === 'failed' ? 'border-l-danger'
    : status === 'retrying' ? 'border-l-warning'
    : 'border-l-info';

  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-display font-semibold text-foreground">Demo workflows</h3>
          <p className="text-xs text-muted-foreground">Read-only fixtures from <code className="font-mono">demoData.ts</code> — illustrate status, retries, and durations.</p>
        </div>
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{demoWorkflows.length} pipelines</span>
      </div>
      <div className="space-y-2.5">
        {demoWorkflows.map(w => {
          const totalDur = w.steps.reduce((a, s) => a + s.durationMs, 0) || 1;
          return (
            <div
              key={w.id}
              className={`group rounded-md border border-border border-l-2 ${accentBorder(w.status)} bg-muted/20 p-3 transition-colors hover:bg-muted/40 hover:border-border-strong`}
            >
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-foreground truncate">{w.name}</span>
                  <span className="text-[11px] font-mono text-muted-foreground capitalize">· {w.connector}</span>
                  <span className="text-[10px] font-mono text-muted-foreground/70">· {w.steps.length} steps</span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge tone={tone(w.status)} dot>{w.status}</StatusBadge>
                  <span className="text-[11px] font-mono text-muted-foreground tabular-nums">{(w.executionDurationMs / 1000).toFixed(1)}s</span>
                  <span className={`text-[11px] font-mono tabular-nums ${w.retryCount > 0 ? 'text-warning' : 'text-muted-foreground'}`}>×{w.retryCount} retries</span>
                  <span className="text-[11px] font-mono text-muted-foreground hidden md:inline">{new Date(w.lastRun).toLocaleString()}</span>
                </div>
              </div>

              {/* Execution timeline — proportional segments per step */}
              <div className="mt-2.5 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                {w.steps.map((s, i) => (
                  <div
                    key={i}
                    title={`${s.name} · ${(s.durationMs / 1000).toFixed(1)}s · ${s.status}`}
                    className={`${segBg(s.status)} h-full ${i > 0 ? 'border-l border-background' : ''}`}
                    style={{ width: `${(s.durationMs / totalDur) * 100}%` }}
                  />
                ))}
              </div>

              {w.failureReason && (
                <p className="mt-2 text-[11px] font-mono text-danger flex items-center gap-1.5">
                  <XCircle className="h-3 w-3" /> {w.failureReason}
                </p>
              )}
              <details className="mt-3 group">
                <summary className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                  execution graph · {w.steps.length} nodes
                </summary>
                <div className="mt-2">
                  <ExecutionGraph workflow={w} />
                </div>
              </details>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function Workflows() {
  const workflows = useApiStore(s => s.workflows);
  const addWorkflow = useApiStore(s => s.addWorkflow);
  const demoMode = useApiStore(s => s.demoMode);
  const loadDemoOperations = useApiStore(s => s.loadDemoOperations);
  const [newName, setNewName] = useState('');

  const handleCreate = () => {
    if (!newName.trim()) return;
    addWorkflow(newName.trim());
    setNewName('');
    toast({ title: `Workflow "${newName}" created` });
  };

  return (
    <div className="px-6 lg:px-8 py-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Workflows"
        description={
          <>Chain API calls and pass data between steps with <code className="font-mono text-xs px-1 py-0.5 rounded bg-muted text-foreground">{'{{0.output.id}}'}</code> placeholders.</>
        }
        actions={
          !demoMode ? (
            <Button variant="outline" size="sm" onClick={loadDemoOperations}>Load Demo Operations</Button>
          ) : undefined
        }
      />

      <DemoWorkflowsSection />

      <div className="panel p-4 flex gap-3">
        <Input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="Workflow name…"
          className="h-9 text-sm flex-1"
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
        <Button onClick={handleCreate} disabled={!newName.trim()} size="sm">
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Create
        </Button>
      </div>

      {workflows.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<GitBranch className="h-5 w-5" />}
            title="No user workflows yet"
            description="Create one to chain API calls and pass data between steps."
          />
        </div>
      ) : (
        <div className="space-y-4">
          {workflows.map(w => <WorkflowCard key={w.id} workflow={w} />)}
        </div>
      )}

      <RunHistory />
    </div>
  );
}
