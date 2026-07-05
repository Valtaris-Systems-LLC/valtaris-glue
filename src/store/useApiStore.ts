import { create } from 'zustand';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import {
  demoWorkflows,
  demoRuns,
  demoConnectorHealth,
  demoOperationalLogs,
  type DemoWorkflow,
  type DemoRun,
  type DemoConnectorHealth,
  type DemoOperationalLog,
} from '@/lib/demoData';

const SUPPORTED_ACTIONS: Record<string, string[]> = {
  stripe: ['charge', 'refund', 'createCustomer'],
  openai: ['generateText', 'generateImage'],
  sendgrid: ['sendEmail'],
  twilio: ['sendMessage'],
  slack: ['postMessage', 'createChannel'],
  salesforce: ['createLead', 'updateOpportunity'],
};

export interface ConnectedService {
  name: string;
  actions: string[];
  connectedAt: Date;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  serviceAction: string;
  status: 'success' | 'error' | 'pending';
  duration?: number;
  data?: Json;
  error?: string;
}

export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  createdAt: Date;
  lastRun?: Date;
  status: 'idle' | 'running' | 'completed' | 'failed';
}

export interface WorkflowStep {
  id: string;
  service: string;
  action: string;
  data: Record<string, Json | undefined>;
  status: 'pending' | 'success' | 'error' | 'skipped' | 'idle';
  result?: ExecutionResult;
  // Per-step retry/recovery configuration
  maxRetries?: number;        // total attempts beyond the first try; default 0
  retryDelayMs?: number;      // base delay; doubles each retry; default 500
  onError?: 'stop' | 'continue' | 'skip'; // what to do if step ultimately fails; default 'stop'
}

export interface ExecutionResult {
  success: boolean;
  error?: string;
  data?: Json;
  duration?: number;
  input?: Json;
  output?: Record<string, Json | undefined>;
}

interface ApiState {
  connectedServices: ConnectedService[];
  logs: LogEntry[];
  workflows: Workflow[];
  selectedService: string | null;
  selectedAction: string | null;
  response: ExecutionResult | null;
  loading: boolean;

  // Demo / operational surfaces
  demoMode: boolean;
  demoWorkflows: DemoWorkflow[];
  runs: DemoRun[];
  connectorHealth: DemoConnectorHealth[];
  operationalLogs: DemoOperationalLog[];

  loadDemoOperations: () => void;
  clearDemoOperations: () => void;

  connect: (serviceName: string) => { success: boolean; error?: string };
  disconnect: (serviceName: string) => void;
  execute: (serviceAction: string, data: Record<string, Json | undefined>) => Promise<ExecutionResult>;
  setSelectedService: (service: string | null) => void;
  setSelectedAction: (action: string | null) => void;
  clearResponse: () => void;

  addWorkflow: (name: string) => string;
  addWorkflowStep: (workflowId: string, step: Omit<WorkflowStep, 'id' | 'status'>) => void;
  removeWorkflowStep: (workflowId: string, stepId: string) => void;
  updateWorkflowStepData: (workflowId: string, stepId: string, data: Record<string, Json | undefined>) => void;
  updateWorkflowStepRetry: (workflowId: string, stepId: string, cfg: { maxRetries?: number; retryDelayMs?: number; onError?: 'stop' | 'continue' | 'skip' }) => void;
  runWorkflow: (workflowId: string, opts?: { resumeFromIndex?: number; previousContext?: Record<string, ExecutionResult> }) => Promise<void>;
  retryWorkflowFromFailed: (workflowId: string) => Promise<void>;
  deleteWorkflow: (workflowId: string) => void;
}

// Resolve placeholders like {{1.output.id}} or {{0.output.text}} from prior step results
function interpolate(value: Json, context: Record<string, ExecutionResult>): Json {
  if (typeof value === 'string') {
    // If the entire string is a single placeholder, return the raw resolved value (preserves type)
    const single = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (single) return resolvePath(context, single[1]) ?? value;
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
      const resolved = resolvePath(context, path);
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map(v => interpolate(v, context));
  if (value && typeof value === 'object') {
    const out: Record<string, Json | undefined> = {};
    for (const k of Object.keys(value)) out[k] = interpolate(value[k], context);
    return out;
  }
  return value;
}

function resolvePath(obj: unknown, path: string): Json | undefined {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj) as Json | undefined;
}

export const useApiStore = create<ApiState>((set, get) => ({
  connectedServices: [],
  logs: [],
  workflows: [],
  selectedService: null,
  selectedAction: null,
  response: null,
  loading: false,

  demoMode: false,
  demoWorkflows: [],
  runs: [],
  connectorHealth: [],
  operationalLogs: [],

  loadDemoOperations: () => {
    for (const name of Object.keys(SUPPORTED_ACTIONS)) {
      const actions = SUPPORTED_ACTIONS[name];
      set(s => ({
        connectedServices: [
          ...s.connectedServices.filter(c => c.name !== name),
          { name, actions, connectedAt: new Date() },
        ],
      }));
    }
    const syntheticLogs: LogEntry[] = demoRuns.map(r => ({
      id: r.runId,
      timestamp: new Date(r.timestamp),
      serviceAction: `${r.connector}.${r.workflowName}`,
      status: (r.status === 'succeeded' || r.status === 'completed') ? 'success'
        : (r.status === 'failed' || r.status === 'escalated') ? 'error'
        : 'pending',
      duration: r.executionDurationMs,
      error: r.failureReason,
    }));
    set({
      demoMode: true,
      demoWorkflows,
      runs: demoRuns,
      connectorHealth: demoConnectorHealth,
      operationalLogs: demoOperationalLogs,
      logs: syntheticLogs,
    });
  },

  clearDemoOperations: () => {
    set({
      demoMode: false,
      demoWorkflows: [],
      runs: [],
      connectorHealth: [],
      operationalLogs: [],
      logs: [],
    });
  },

  connect: (serviceName: string) => {
    const actions = SUPPORTED_ACTIONS[serviceName];
    if (!actions) {
      return { success: false, error: `Unknown service "${serviceName}". Available: ${Object.keys(SUPPORTED_ACTIONS).join(', ')}` };
    }
    set(s => ({
      connectedServices: [
        ...s.connectedServices.filter(c => c.name !== serviceName),
        { name: serviceName, actions, connectedAt: new Date() },
      ],
    }));
    return { success: true };
  },

  disconnect: (serviceName) => {
    set(s => ({ connectedServices: s.connectedServices.filter(c => c.name !== serviceName) }));
  },

  execute: async (serviceAction, data) => {
    const dotIndex = serviceAction.indexOf('.');
    if (dotIndex === -1) {
      return { success: false, error: `Invalid format. Expected "service.action"` };
    }
    const service = serviceAction.substring(0, dotIndex);
    const action = serviceAction.substring(dotIndex + 1);

    const id = crypto.randomUUID();
    set(s => ({
      loading: true,
      response: null,
      logs: [{ id, timestamp: new Date(), serviceAction, status: 'pending' as const }, ...s.logs].slice(0, 100),
    }));

    const start = performance.now();
    let result: ExecutionResult;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { data: respData, error } = await supabase.functions.invoke('execute-api', {
        body: { service, action, data, user_id: session?.user?.id ?? null },
      });

      if (error) {
        result = { success: false, error: error.message };
      } else {
        result = respData;
      }
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }

    const duration = Math.round(performance.now() - start);

    set(s => ({
      loading: false,
      response: { ...result, duration },
      logs: s.logs.map(l =>
        l.id === id
          ? { ...l, status: (result.success ? 'success' : 'error') as 'success' | 'error', duration, data: result.data, error: result.error }
          : l
      ),
    }));
    return { ...result, duration };
  },

  setSelectedService: (service) => set({ selectedService: service, selectedAction: null }),
  setSelectedAction: (action) => set({ selectedAction: action }),
  clearResponse: () => set({ response: null }),

  addWorkflow: (name) => {
    const id = crypto.randomUUID();
    set(s => ({
      workflows: [...s.workflows, { id, name, steps: [], createdAt: new Date(), status: 'idle' as const }],
    }));
    return id;
  },

  addWorkflowStep: (workflowId, step) => {
    set(s => ({
      workflows: s.workflows.map(w =>
        w.id === workflowId
          ? { ...w, steps: [...w.steps, { ...step, id: crypto.randomUUID(), status: 'idle' as const }] }
          : w
      ),
    }));
  },

  removeWorkflowStep: (workflowId, stepId) => {
    set(s => ({
      workflows: s.workflows.map(w =>
        w.id === workflowId ? { ...w, steps: w.steps.filter(st => st.id !== stepId) } : w
      ),
    }));
  },

  updateWorkflowStepData: (workflowId, stepId, data) => {
    set(s => ({
      workflows: s.workflows.map(w =>
        w.id === workflowId
          ? { ...w, steps: w.steps.map(st => (st.id === stepId ? { ...st, data } : st)) }
          : w
      ),
    }));
  },

  updateWorkflowStepRetry: (workflowId, stepId, cfg) => {
    set(s => ({
      workflows: s.workflows.map(w =>
        w.id === workflowId
          ? { ...w, steps: w.steps.map(st => (st.id === stepId ? { ...st, ...cfg } : st)) }
          : w
      ),
    }));
  },

  runWorkflow: async (workflowId, opts) => {
    const { workflows } = get();
    const workflow = workflows.find(w => w.id === workflowId);
    if (!workflow || workflow.steps.length === 0) return;

    const resumeFromIndex = opts?.resumeFromIndex ?? 0;
    const startedAt = new Date();
    const runStart = performance.now();
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;

    let runId: string | null = null;
    if (userId) {
      const { data: runRow } = await supabase
        .from('workflow_runs')
        .insert({
          user_id: userId,
          workflow_id: workflow.id,
          workflow_name: resumeFromIndex > 0 ? `${workflow.name} (resume @${resumeFromIndex + 1})` : workflow.name,
          status: 'running',
          steps: [],
          context: opts?.previousContext ?? {},
          started_at: startedAt.toISOString(),
        })
        .select('id')
        .single();
      runId = runRow?.id ?? null;
    }

    set(s => ({
      workflows: s.workflows.map(w =>
        w.id === workflowId
          ? {
              ...w,
              status: 'running' as const,
              steps: w.steps.map((st, i) =>
                i >= resumeFromIndex ? { ...st, status: 'pending' as const, result: undefined } : st
              ),
            }
          : w
      ),
    }));

    const context: Record<string, ExecutionResult> = { ...(opts?.previousContext ?? {}) };
    const stepResults: Array<Record<string, Json | undefined>> = [];
    let finalStatus: 'completed' | 'failed' = 'completed';
    let runError: string | null = null;

    for (let i = resumeFromIndex; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const maxRetries = step.maxRetries ?? 0;
      const baseDelay = step.retryDelayMs ?? 500;
      const onError = step.onError ?? 'stop';

      let attempt = 0;
      let result: ExecutionResult;
      let resolvedData: Json;
      while (true) {
        resolvedData = interpolate(step.data, context);
        const serviceAction = `${step.service}.${step.action}`;
        result = await get().execute(serviceAction, resolvedData);
        if (result.success || attempt >= maxRetries) break;
        attempt++;
        // Exponential backoff
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
      }

      const fileFields: Record<string, Json | undefined> = {};
      if (resolvedData && typeof resolvedData === 'object') {
        for (const k of ['fileUrl', 'filePath', 'fileName', 'fileType', 'fileSize']) {
          if (!Array.isArray(resolvedData) && resolvedData[k] !== undefined) fileFields[k] = resolvedData[k];
        }
      }
      const output = {
        ...fileFields,
        ...(result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {}),
      };

      context[i] = { ...result, input: resolvedData, output };

      const failed = !result.success;
      const skipped = failed && onError === 'skip';
      const stepStatus: 'success' | 'error' | 'skipped' = result.success ? 'success' : (skipped ? 'skipped' : 'error');

      stepResults.push({
        index: i,
        service: step.service,
        action: step.action,
        input: resolvedData,
        output,
        result,
        success: !!result.success,
        attempts: attempt + 1,
        status: stepStatus,
        duration_ms: result.duration,
      });

      set(s => ({
        workflows: s.workflows.map(w =>
          w.id === workflowId
            ? {
                ...w,
                steps: w.steps.map(st =>
                  st.id === step.id ? { ...st, status: stepStatus, result } : st
                ),
              }
            : w
        ),
      }));

      if (failed && onError === 'stop') {
        finalStatus = 'failed';
        runError = result.error || 'Step failed';
        break;
      }
      if (failed && onError === 'continue') {
        // Mark the run as failed overall but keep going
        finalStatus = 'failed';
        runError = runError ?? (result.error || 'Step failed');
      }
      // 'skip' → run continues, status stays 'completed' unless something else fails
    }

    const duration = Math.round(performance.now() - runStart);

    set(s => ({
      workflows: s.workflows.map(w =>
        w.id === workflowId ? { ...w, status: finalStatus, lastRun: new Date() } : w
      ),
    }));

    if (runId) {
      await supabase.from('workflow_runs').update({
        status: finalStatus,
        steps: stepResults,
        context,
        duration_ms: duration,
        error: runError,
        finished_at: new Date().toISOString(),
      }).eq('id', runId);
    }
  },

  retryWorkflowFromFailed: async (workflowId) => {
    const { workflows } = get();
    const workflow = workflows.find(w => w.id === workflowId);
    if (!workflow) return;
    const failedIndex = workflow.steps.findIndex(s => s.status === 'error');
    const startIndex = failedIndex === -1 ? 0 : failedIndex;
    // Rebuild a context from prior successful steps' results
    const previousContext: Record<string, ExecutionResult> = {};
    for (let i = 0; i < startIndex; i++) {
      const r = workflow.steps[i].result;
      if (r) previousContext[i] = r;
    }
    await get().runWorkflow(workflowId, { resumeFromIndex: startIndex, previousContext });
  },

  deleteWorkflow: (workflowId) => {
    set(s => ({ workflows: s.workflows.filter(w => w.id !== workflowId) }));
  },
}));
