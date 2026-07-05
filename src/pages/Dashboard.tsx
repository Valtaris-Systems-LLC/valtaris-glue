import { useApiStore } from '@/store/useApiStore';
import { Activity, CheckCircle, XCircle, Plug, Zap, Clock, ArrowRight, Sparkles, Trash2, GitBranch, Timer } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { MissionControlMetrics, ConnectorTelemetryGrid } from '@/components/mission/MissionControl';
import { LiveTicker } from '@/components/mission/LiveTicker';
import { IncidentFeed } from '@/components/mission/IncidentFeed';
import { Heatmap } from '@/components/mission/Heatmap';
import { DecisionWeaver } from '@/components/mission/DecisionWeaver';
import { QueueGauge } from '@/components/mission/QueueGauge';
import { LiveTelemetryPanel } from '@/components/mission/LiveTelemetryPanel';
import { LiveOpsRuntime } from '@/components/mission/LiveOpsRuntime';
import { ReplayConsole } from '@/components/mission/ReplayConsole';
import { OrchestrationGraph } from '@/components/mission/OrchestrationGraph';
import { GovernancePanel } from '@/components/mission/GovernancePanel';
import { ConnectorMatrix } from '@/components/mission/ConnectorMatrix';
import { ApprovalQueue } from '@/components/mission/ApprovalQueue';
import { ObservabilityPanel } from '@/components/mission/ObservabilityPanel';
import { ControlPlanePanel } from '@/components/mission/ControlPlanePanel';
import { RuntimeHealth } from '@/components/mission/RuntimeHealth';
import { SecurityEventsFeed } from '@/components/mission/SecurityEventsFeed';
import { ActivationPanel } from '@/components/mission/ActivationPanel';
import { ScaleInfrastructurePanel } from '@/components/mission/ScaleInfrastructurePanel';

const healthTone = (status: string): 'success' | 'warning' | 'info' | 'danger' =>
  status === 'healthy' ? 'success'
  : status === 'degraded' ? 'warning'
  : status === 'retrying' ? 'info'
  : 'danger';

export default function Dashboard() {
  const connectedServices = useApiStore(s => s.connectedServices);
  const logs = useApiStore(s => s.logs);
  const demoMode = useApiStore(s => s.demoMode);
  const demoWorkflows = useApiStore(s => s.demoWorkflows);
  const runs = useApiStore(s => s.runs);
  const connectorHealth = useApiStore(s => s.connectorHealth);
  const loadDemoOperations = useApiStore(s => s.loadDemoOperations);
  const clearDemoOperations = useApiStore(s => s.clearDemoOperations);

  const totalExecutions = logs.length;
  const successCount = logs.filter(l => l.status === 'success').length;
  const errorCount = logs.filter(l => l.status === 'error').length;
  const successRate = totalExecutions > 0 ? Math.round((successCount / totalExecutions) * 100) : 0;

  // Demo-aware metrics
  const totalWorkflows = demoMode ? demoWorkflows.length : 0;
  const successfulRuns = demoMode ? runs.filter(r => r.status === 'succeeded').length : successCount;
  const failedRuns = demoMode ? runs.filter(r => r.status === 'failed').length : errorCount;
  const avgDurationMs = demoMode && runs.length
    ? Math.round(runs.reduce((acc, r) => acc + r.executionDurationMs, 0) / runs.length)
    : 0;

  return (
    <div className="px-6 lg:px-8 py-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Dashboard"
        description="Operational overview of your API Unity OS instance — connectors, executions, and recent activity."
        actions={
          <>
            {demoMode ? (
              <Button variant="outline" size="sm" onClick={clearDemoOperations}>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Clear demo data
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={loadDemoOperations}>
                <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Load Demo Operations
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to="/connectors">Manage connectors</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/playground">Open playground <ArrowRight className="h-3.5 w-3.5 ml-1.5" /></Link>
            </Button>
          </>
        }
      />

      {demoMode && (
        <div className="rounded-md border border-info/30 bg-info/5 px-4 py-2.5 text-xs text-foreground flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-info" />
          <span><strong>Demo mode</strong> is on — workflows, runs, and connector health below are seeded fixtures from <code className="font-mono">src/lib/demoData.ts</code>.</span>
        </div>
      )}

      {/* Mission Control: live runtime telemetry */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-base font-semibold text-foreground">Mission Control</h2>
            <p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">runtime · operational intelligence</p>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums">simulation · live tick</span>
        </div>
        <MissionControlMetrics />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <Heatmap />
            <ConnectorTelemetryGrid />
          </div>
          <div className="space-y-4">
            <QueueGauge />
            <IncidentFeed />
            <LiveTicker height={260} />
          </div>
        </div>
        <DecisionWeaver />
      </section>

      <LiveOpsRuntime />

      <OrchestrationGraph />

      <ConnectorMatrix />

      <ControlPlanePanel />

      <ActivationPanel />

      <ScaleInfrastructurePanel />


      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ObservabilityPanel />
        <ApprovalQueue />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RuntimeHealth />
        <SecurityEventsFeed />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LiveTelemetryPanel />
        <GovernancePanel compact />
      </div>

      <ReplayConsole />





      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {demoMode ? (
          <>
            <StatCard tone="primary" label="Workflows" value={totalWorkflows} icon={<GitBranch className="h-4 w-4" />} hint="loaded from demo" />
            <StatCard tone="success" label="Successful runs" value={successfulRuns} icon={<CheckCircle className="h-4 w-4" />} hint={`of ${runs.length} total`} />
            <StatCard tone={failedRuns > 0 ? 'danger' : 'neutral'} label="Failed runs" value={failedRuns} icon={<XCircle className="h-4 w-4" />} hint={failedRuns > 0 ? 'review runs' : 'all clear'} />
            <StatCard tone="info" label="Avg duration" value={`${(avgDurationMs / 1000).toFixed(1)}s`} icon={<Timer className="h-4 w-4" />} hint="across demo runs" />
          </>
        ) : (
          <>
            <StatCard tone="primary" label="Connected APIs" value={connectedServices.length} icon={<Plug className="h-4 w-4" />} hint="of 4 available" />
            <StatCard tone="info" label="Executions" value={totalExecutions} icon={<Zap className="h-4 w-4" />} hint="across this session" />
            <StatCard
              tone={errorCount === 0 && totalExecutions > 0 ? 'success' : 'neutral'}
              label="Success rate"
              value={`${successRate}%`}
              icon={<CheckCircle className="h-4 w-4" />}
              delta={totalExecutions > 0 ? { value: `${successCount}`, trend: errorCount === 0 ? 'up' : 'neutral' } : undefined}
            />
            <StatCard tone={errorCount > 0 ? 'danger' : 'neutral'} label="Errors" value={errorCount} icon={<XCircle className="h-4 w-4" />} hint={errorCount > 0 ? 'review activity' : 'all clear'} />
          </>
        )}
      </div>

      {demoMode && connectorHealth.length > 0 && (
        <section className="panel p-5">
          <header className="flex items-center justify-between mb-4">
            <h2 className="font-display text-sm font-semibold text-foreground">Connector health</h2>
            <Link to="/connectors" className="text-xs text-primary hover:underline">View all</Link>
          </header>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {connectorHealth.map(h => (
              <li key={h.connector} className="rounded-md border border-border bg-muted/30 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground capitalize">{h.connector}</span>
                  <StatusBadge tone={healthTone(h.status)} dot>{h.status}</StatusBadge>
                </div>
                <div className="text-[11px] font-mono text-muted-foreground tabular-nums">
                  latency {h.latencyMs != null ? `${h.latencyMs}ms` : '—'} · failures {Math.round(h.failureRate * 100)}%
                </div>
                <div className="text-[11px] font-mono text-muted-foreground truncate">
                  last ok {h.lastSuccessfulExecution ? new Date(h.lastSuccessfulExecution).toLocaleString() : '—'}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="panel p-5 lg:col-span-1">
          <header className="flex items-center justify-between mb-4">
            <h2 className="font-display text-sm font-semibold text-foreground">Active services</h2>
            <Link to="/connectors" className="text-xs text-primary hover:underline">View all</Link>
          </header>
          {connectedServices.length === 0 ? (
            <EmptyState
              icon={<Plug className="h-5 w-5" />}
              title="No services connected"
              description="Connect a service or click Load Demo Operations to see the platform in action."
              action={<Button size="sm" variant="outline" onClick={loadDemoOperations}><Sparkles className="h-3.5 w-3.5 mr-1.5" /> Load demo</Button>}
            />
          ) : (
            <ul className="space-y-2">
              {connectedServices.map(s => (
                <li key={s.name} className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="h-1.5 w-1.5 rounded-full bg-success shrink-0" />
                    <span className="text-sm font-medium text-foreground capitalize truncate">{s.name}</span>
                  </div>
                  <span className="text-[11px] font-mono text-muted-foreground">{s.actions.length} actions</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel p-5 lg:col-span-2">
          <header className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <h2 className="font-display text-sm font-semibold text-foreground">Recent activity</h2>
            </div>
            {logs.length > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">{logs.length} entries</span>
            )}
          </header>

          {logs.length === 0 ? (
            <EmptyState
              icon={<Zap className="h-5 w-5" />}
              title="No activity yet"
              description="Execute your first request from the playground — or load demo operations to populate the feed."
              action={<Button asChild size="sm"><Link to="/playground">Open playground</Link></Button>}
            />
          ) : (
            <ScrollArea className="h-[340px]">
              <ul className="divide-y divide-border">
                {logs.map(log => (
                  <li key={log.id} className="flex items-center gap-3 py-2.5 px-1">
                    {log.status === 'pending' && <Clock className="h-3.5 w-3.5 text-info animate-spin shrink-0" />}
                    {log.status === 'success' && <CheckCircle className="h-3.5 w-3.5 text-success shrink-0" />}
                    {log.status === 'error' && <XCircle className="h-3.5 w-3.5 text-danger shrink-0" />}
                    <span className="font-mono text-xs text-foreground flex-1 truncate">{log.serviceAction}</span>
                    <StatusBadge tone={log.status === 'success' ? 'success' : log.status === 'error' ? 'danger' : 'info'}>
                      {log.status}
                    </StatusBadge>
                    {log.duration !== undefined && (
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums shrink-0 w-16 text-right">{log.duration}ms</span>
                    )}
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums shrink-0">
                      {log.timestamp.toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </section>
      </div>
    </div>
  );
}
