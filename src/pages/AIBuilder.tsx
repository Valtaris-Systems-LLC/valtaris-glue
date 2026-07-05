import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApiStore, type WorkflowStep } from '@/store/useApiStore';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { Sparkles, Loader2, ArrowRight, CheckCircle, Save, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';

type GeneratedStep = Pick<WorkflowStep, 'service' | 'action'> & { data: Record<string, Json | undefined> };
interface GeneratedWorkflow { name: string; steps: GeneratedStep[]; }

const EXAMPLE_PROMPTS = [
  "When a payment is received in Stripe, send a confirmation email",
  "Generate an AI image and send it via SMS",
  "Create a new Stripe customer and send them a welcome email",
  "Generate a poem with AI and email it to the team",
];

export default function AIBuilder() {
  const navigate = useNavigate();
  const addWorkflow = useApiStore(s => s.addWorkflow);
  const addWorkflowStep = useApiStore(s => s.addWorkflowStep);

  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GeneratedWorkflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setLoading(true); setResult(null); setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('generate-workflow', {
        body: { prompt: prompt.trim() },
      });
      if (fnError) throw new Error(fnError.message);
      if (data?.error) throw new Error(data.error);
      if (!data?.workflow) throw new Error('No workflow returned');
      setResult(data.workflow);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate workflow';
      setError(message);
      toast({ title: 'Generation failed', description: message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  const handleSave = () => {
    if (!result) return;
    const workflowId = addWorkflow(result.name);
    for (const step of result.steps) {
      addWorkflowStep(workflowId, { service: step.service, action: step.action, data: step.data });
    }
    toast({ title: `Workflow "${result.name}" saved` });
    navigate('/workflows');
  };

  const handleReset = () => { setResult(null); setError(null); setPrompt(''); };

  return (
    <div className="px-6 lg:px-8 py-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="AI Builder"
        description="Describe a workflow in plain English. We'll generate a validated, executable definition you can save and run."
        actions={<StatusBadge tone="primary" dot>Powered by AI</StatusBadge>}
      />

      <section className="panel p-5 space-y-4">
        <Textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="e.g. When a payment is received in Stripe, send me a confirmation email…"
          className="min-h-[110px] text-sm resize-none"
          maxLength={500}
          disabled={loading}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">{prompt.length}/500</span>
          <Button onClick={handleGenerate} disabled={!prompt.trim() || loading}>
            {loading
              ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Generating…</>
              : <><Sparkles className="h-3.5 w-3.5 mr-1.5" /> Generate workflow</>}
          </Button>
        </div>
      </section>

      {!result && !loading && (
        <section className="space-y-2">
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Try an example</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {EXAMPLE_PROMPTS.map((ex, i) => (
              <button
                key={i}
                onClick={() => setPrompt(ex)}
                className="text-left text-sm p-3 rounded-md border border-border bg-muted/30 hover:bg-muted hover:border-border-strong transition-colors text-foreground/80 hover:text-foreground"
              >
                {ex}
              </button>
            ))}
          </div>
        </section>
      )}

      {error && (
        <section className="panel p-4 border-danger/40 bg-danger/5">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="outline" size="sm" onClick={handleGenerate} className="mt-3">
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Retry
          </Button>
        </section>
      )}

      {result && (
        <section className="panel p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Generated workflow</p>
              <h3 className="font-display font-semibold text-foreground text-lg mt-0.5">{result.name}</h3>
            </div>
            <StatusBadge tone="success"><CheckCircle className="h-3 w-3" /> Validated</StatusBadge>
          </div>

          <div className="space-y-2">
            {result.steps.map((step, i) => (
              <div key={i}>
                {i > 0 && (
                  <div className="flex justify-center py-0.5">
                    <ArrowRight className="h-3 w-3 text-muted-foreground/40 rotate-90" />
                  </div>
                )}
                <div className="flex items-start gap-3 p-3 rounded-md bg-muted/40 border border-border">
                  <span className="text-[11px] font-mono text-muted-foreground w-6 shrink-0 mt-0.5">#{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-sm text-foreground">{step.service}.{step.action}</span>
                    {Object.keys(step.data).length > 0 && (
                      <pre className="text-xs font-mono text-muted-foreground mt-1.5 overflow-x-auto scrollbar-thin">
                        {JSON.stringify(step.data, null, 2)}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <details className="group">
            <summary className="text-xs font-medium uppercase tracking-widest text-muted-foreground cursor-pointer hover:text-foreground">
              View raw JSON
            </summary>
            <pre className="mt-2 p-3 rounded-md bg-muted/40 border border-border text-xs font-mono text-foreground overflow-x-auto scrollbar-thin">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>

          <div className="flex gap-2 pt-2">
            <Button onClick={handleSave}><Save className="h-3.5 w-3.5 mr-1.5" /> Save to Workflows</Button>
            <Button variant="outline" onClick={handleReset}><RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Start over</Button>
          </div>
        </section>
      )}
    </div>
  );
}
