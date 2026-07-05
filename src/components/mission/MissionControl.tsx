import { useRuntimeStore } from '@/store/useRuntimeStore';
import { StatCard } from '@/components/ui/stat-card';
import { Activity, AlertTriangle, Gauge, Plug } from 'lucide-react';
import { Sparkline } from './Sparkline';

export function MissionControlMetrics() {
  const health = useRuntimeStore(s => s.connectorHealth);
  const activeRuns = useRuntimeStore(s => s.activeRuns);
  const slaAtRisk = useRuntimeStore(s => s.slaAtRisk);
  const queueDepth = useRuntimeStore(s => s.queueDepth);
  const incidents = useRuntimeStore(s => s.incidents);

  const avgLatency = Math.round(
    health.filter(h => h.latencyMs != null).reduce((a, h) => a + (h.latencyMs ?? 0), 0) /
    Math.max(1, health.filter(h => h.latencyMs != null).length),
  );
  const uptime = (100 - (health.reduce((a, h) => a + h.failureRate, 0) / health.length) * 100);
  const latencyAggSeries = Array.from({ length: 24 }, (_, i) =>
    Math.round(health.reduce((a, h) => a + (h.latencySeries[i] ?? 0), 0) / health.length)
  );

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="relative">
        <StatCard tone="info" label="Active runs" value={activeRuns} icon={<Activity className="h-4 w-4" />} hint={`${queueDepth} queued`} />
      </div>
      <div className="relative">
        <StatCard tone={slaAtRisk > 0 ? 'danger' : 'neutral'} label="SLA at risk" value={slaAtRisk} icon={<AlertTriangle className="h-4 w-4" />} hint={`${incidents.length} open incidents`} />
      </div>
      <div className="relative overflow-hidden">
        <StatCard tone="primary" label="p50 latency" value={`${avgLatency}ms`} icon={<Gauge className="h-4 w-4" />} hint="rolling 24 ticks" />
        <div className="absolute bottom-1 left-3 right-3 pointer-events-none opacity-70">
          <Sparkline data={latencyAggSeries} tone="primary" height={18} />
        </div>
      </div>
      <div className="relative">
        <StatCard tone={uptime > 95 ? 'success' : uptime > 80 ? 'warning' : 'danger'} label="Uptime" value={`${uptime.toFixed(2)}%`} icon={<Plug className="h-4 w-4" />} hint="aggregate runtime" />
      </div>
    </div>
  );
}

export function ConnectorTelemetryGrid() {
  const health = useRuntimeStore(s => s.connectorHealth);
  return (
    <div className="panel p-4">
      <header className="flex items-center justify-between mb-3">
        <h3 className="font-display text-sm font-semibold text-foreground">Connector telemetry</h3>
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">latency · throughput · quota</span>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {health.map(h => {
          const tone: 'success' | 'warning' | 'info' | 'danger' =
            h.status === 'down' ? 'danger'
            : h.status === 'degraded' ? 'warning'
            : h.status === 'retrying' ? 'info'
            : 'success';
          return (
            <div key={h.connector} className="rounded-md border border-border bg-muted/20 p-3 space-y-2 hover:bg-muted/30 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : tone === 'info' ? 'bg-info' : 'bg-danger'} ${h.status !== 'healthy' ? 'animate-pulse-glow' : ''}`} />
                  <span className="text-sm font-medium capitalize text-foreground">{h.connector}</span>
                </div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{h.status}</span>
              </div>
              <Sparkline data={h.latencySeries} tone={tone} height={28} />
              <div className="grid grid-cols-3 gap-2 text-[10px] font-mono tabular-nums">
                <div>
                  <p className="text-muted-foreground/70 uppercase tracking-wider text-[9px]">p50</p>
                  <p className="text-foreground">{h.latencyMs != null ? `${h.latencyMs}ms` : '—'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground/70 uppercase tracking-wider text-[9px]">rpm</p>
                  <p className="text-foreground">{h.throughputRpm}</p>
                </div>
                <div>
                  <p className="text-muted-foreground/70 uppercase tracking-wider text-[9px]">fail</p>
                  <p className={h.failureRate > 0.2 ? 'text-danger' : h.failureRate > 0 ? 'text-warning' : 'text-foreground'}>
                    {(h.failureRate * 100).toFixed(1)}%
                  </p>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[10px] font-mono text-muted-foreground mb-0.5">
                  <span>quota</span><span className="tabular-nums">{Math.round(h.quotaUsed * 100)}%</span>
                </div>
                <div className="h-1 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full ${h.quotaUsed > 0.8 ? 'bg-danger' : h.quotaUsed > 0.6 ? 'bg-warning' : 'bg-primary'}`} style={{ width: `${h.quotaUsed * 100}%` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
