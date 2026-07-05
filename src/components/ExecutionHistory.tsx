import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Database, Json } from '@/integrations/supabase/types';
import { useApiStore } from '@/store/useApiStore';
import { CheckCircle, XCircle, FlaskConical, RotateCcw, Bookmark } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { ScrollArea } from '@/components/ui/scroll-area';

type ApiRequest = Database['public']['Tables']['api_requests']['Row'] & {
  request_data: Record<string, unknown>;
  response_data: Record<string, unknown>;
};

type ApiRequestInsert = Database['public']['Tables']['api_requests']['Insert'];

function toRecord(value: Json | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function ExecutionHistory() {
  const [history, setHistory] = useState<ApiRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const setSelectedService = useApiStore(s => s.setSelectedService);
  const setSelectedAction = useApiStore(s => s.setSelectedAction);
  const execute = useApiStore(s => s.execute);

  const fetchHistory = async () => {
    const { data, error } = await supabase
      .from('api_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (!error && data) {
      setHistory(data.map((item) => ({
        ...item,
        request_data: toRecord(item.request_data),
        response_data: toRecord(item.response_data),
      })));
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleRerun = async (item: ApiRequest) => {
    setSelectedService(item.service);
    setTimeout(() => setSelectedAction(item.action), 0);
    toast({ title: `Re-running ${item.service}.${item.action}...` });
    await execute(`${item.service}.${item.action}`, item.request_data);
    fetchHistory();
  };

  const handleSave = async (item: ApiRequest) => {
    const payload: ApiRequestInsert = {
      service: item.service,
      action: item.action,
      request_data: item.request_data,
      response_data: {},
      success: false,
      mock: false,
      duration_ms: null,
    };
    const { error } = await supabase.from('api_requests').insert([payload]);
    if (error) {
      toast({ title: 'Failed to save', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Request saved as template' });
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="glass-panel p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Execution History
        </h2>
        <Button variant="ghost" size="sm" onClick={fetchHistory} className="text-xs font-mono h-7">
          <RotateCcw className="h-3 w-3 mr-1" /> Refresh
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : history.length === 0 ? (
          <p className="text-xs font-mono text-muted-foreground text-center py-8">
            No executions yet. Run a request to see history.
          </p>
        ) : (
          <div className="space-y-2">
            {history.map((item) => (
              <div
                key={item.id}
                className="p-3 rounded-md bg-muted/30 border border-border/30 hover:border-border/60 transition-colors"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    {item.success ? (
                      <CheckCircle className="h-3 w-3 text-primary shrink-0" />
                    ) : (
                      <XCircle className="h-3 w-3 text-destructive shrink-0" />
                    )}
                    <span className="font-mono text-xs font-medium text-foreground">
                      {item.service}.{item.action}
                    </span>
                    {item.mock && (
                      <span className="flex items-center gap-0.5 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-500 border border-yellow-500/20">
                        <FlaskConical className="h-2.5 w-2.5" /> mock
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {item.duration_ms !== null && `${item.duration_ms}ms · `}{formatTime(item.created_at)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRerun(item)}
                    className="h-6 text-[10px] font-mono px-2 text-muted-foreground hover:text-foreground"
                  >
                    <RotateCcw className="h-2.5 w-2.5 mr-1" /> Re-run
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSave(item)}
                    className="h-6 text-[10px] font-mono px-2 text-muted-foreground hover:text-foreground"
                  >
                    <Bookmark className="h-2.5 w-2.5 mr-1" /> Save
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
