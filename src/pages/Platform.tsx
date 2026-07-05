// Platform page — Phase 18 productization surface.
// Tabs: Templates, Marketplace, Onboarding, Deployment, Analytics.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePlatform } from "@/store/usePlatform";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import {
  Sparkles, Plug, Rocket, ShieldCheck, BarChart3, CheckCircle2, Circle,
  Search, Package, Boxes,
} from "lucide-react";

type DeploymentCheck = {
  name: string;
  ok: boolean;
};

export default function Platform() {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const {
    categories, templates, connectors, onboardingSteps, progress, validations, installs,
    load, install, installConnector, completeStep, validateDeployment,
  } = usePlatform();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) nav("/auth");
  }, [loading, user, nav]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase.from("tenant_members").select("tenant_id").limit(1).maybeSingle();
      if (data?.tenant_id) setTenantId(data.tenant_id);
      load();
    })();
  }, [user, load]);

  const installedTemplateIds = useMemo(() => new Set(installs.map(i => i.template_id)), [installs]);
  const progressByKey = useMemo(() => new Map(progress.map(p => [p.step_key, p])), [progress]);
  const completedCount = onboardingSteps.filter(s => progressByKey.get(s.key)?.state === "completed").length;
  const onboardingPct = onboardingSteps.length ? (completedCount / onboardingSteps.length) * 100 : 0;

  const filteredTemplates = templates.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || (t.tags ?? []).some(x => x.includes(search.toLowerCase()))
  );

  const doInstall = async (key: string) => {
    if (!tenantId) return toast({ title: "No tenant", description: "Join a workspace first." });
    setBusy(key);
    const r = await install(key, tenantId);
    setBusy(null);
    toast({ title: r.ok ? "Template installed" : "Install failed", description: r.error });
  };

  const doInstallConnector = async (key: string) => {
    if (!tenantId) return;
    setBusy(`c:${key}`);
    const r = await installConnector(key, tenantId);
    setBusy(null);
    toast({ title: r.ok ? "Connector installed" : "Install failed", description: r.error });
  };

  const doValidate = async () => {
    if (!tenantId) return;
    setBusy("validate");
    const r = await validateDeployment(tenantId);
    setBusy(null);
    if (r) toast({ title: `Validation ${r.state}`, description: `${r.passed} passed · ${r.failed} failed · ${r.warnings} warnings` });
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Platform"
        description="Reusable templates, connector marketplace, onboarding, and deployment readiness."
      />


      <Tabs defaultValue="templates" className="w-full">
        <TabsList className="grid grid-cols-5 max-w-3xl">
          <TabsTrigger value="templates"><Sparkles className="h-4 w-4 mr-1" />Templates</TabsTrigger>
          <TabsTrigger value="marketplace"><Plug className="h-4 w-4 mr-1" />Marketplace</TabsTrigger>
          <TabsTrigger value="onboarding"><Rocket className="h-4 w-4 mr-1" />Onboarding</TabsTrigger>
          <TabsTrigger value="deployment"><ShieldCheck className="h-4 w-4 mr-1" />Deployment</TabsTrigger>
          <TabsTrigger value="analytics"><BarChart3 className="h-4 w-4 mr-1" />Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="space-y-4">
          <div className="flex items-center gap-2 max-w-md">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search templates or tags" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            {categories.map(c => <Badge key={c.key} variant="secondary">{c.name}</Badge>)}
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredTemplates.map(t => {
              const installed = installedTemplateIds.has(t.id);
              return (
                <Card key={t.id} className="flex flex-col">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">{t.name}</CardTitle>
                      {t.featured && <Badge>Featured</Badge>}
                    </div>
                    <CardDescription>{t.summary}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col justify-between gap-3">
                    <div className="flex flex-wrap gap-1">
                      {(t.tags ?? []).map(tag => (
                        <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
                      ))}
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{t.install_count} installs</span>
                      <Button size="sm" variant={installed ? "outline" : "default"}
                        disabled={busy === t.key} onClick={() => doInstall(t.key)}>
                        {installed ? "Reinstall" : "Install"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="marketplace" className="space-y-4">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {connectors.map(c => (
              <Card key={c.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Plug className="h-4 w-4" /> {c.name}
                    </CardTitle>
                    {c.featured && <Badge>Featured</Badge>}
                  </div>
                  <CardDescription>{c.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                  <div className="flex gap-1">
                    {c.category && <Badge variant="outline" className="text-[10px]">{c.category}</Badge>}
                    <Badge variant="outline" className="text-[10px]">{c.auth_model}</Badge>
                  </div>
                  <Button size="sm" disabled={busy === `c:${c.key}`} onClick={() => doInstallConnector(c.key)}>
                    Install
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="onboarding" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Workspace readiness</CardTitle>
              <CardDescription>{completedCount} of {onboardingSteps.length} steps complete</CardDescription>
            </CardHeader>
            <CardContent>
              <Progress value={onboardingPct} />
            </CardContent>
          </Card>
          <div className="space-y-2">
            {onboardingSteps.map(s => {
              const done = progressByKey.get(s.key)?.state === "completed";
              return (
                <Card key={s.key}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-start gap-3">
                      {done
                        ? <CheckCircle2 className="h-5 w-5 text-success mt-0.5" />
                        : <Circle className="h-5 w-5 text-muted-foreground mt-0.5" />}
                      <div>
                        <div className="font-medium text-sm">{s.title}</div>
                        <div className="text-xs text-muted-foreground">{s.description}</div>
                      </div>
                    </div>
                    {!done && (
                      <Button size="sm" variant="outline"
                        onClick={() => tenantId && completeStep(s.key, tenantId)}>
                        Mark complete
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="deployment" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Deployment validation</CardTitle>
              <CardDescription>Verify connectors, webhooks, workflows, breakers, and workers before rollout.</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Runs the same readiness checks used by the production runtime.
              </p>
              <Button onClick={doValidate} disabled={!tenantId || busy === "validate"}>
                <ShieldCheck className="h-4 w-4 mr-1" /> Run validation
              </Button>
            </CardContent>
          </Card>
          <div className="space-y-2">
            {validations.map(v => (
              <Card key={v.id}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <Badge variant={v.state === "passed" ? "default" : v.state === "failed" ? "destructive" : "secondary"}>
                      {v.state}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{new Date(v.ran_at).toLocaleString()}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {v.passed} passed · {v.failed} failed · {v.warnings} warnings
                  </div>
                  <div className="space-y-1">
                    {(v.checks as DeploymentCheck[]).map((c, i) => (
                      <div key={i} className="text-xs flex items-center gap-2">
                        {c.ok
                          ? <CheckCircle2 className="h-3 w-3 text-success" />
                          : <Circle className="h-3 w-3 text-destructive" />}
                        <span>{c.name}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="space-y-4">
          <PlatformAnalytics />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PlatformAnalytics() {
  const [stats, setStats] = useState<{ runs: number; completed: number; failed: number; templates: number; installs: number } | null>(null);

  useEffect(() => {
    (async () => {
      const [runs, completed, failed, templates, installs] = await Promise.all([
        supabase.from("workflow_runs").select("*", { count: "exact", head: true }),
        supabase.from("workflow_runs").select("*", { count: "exact", head: true }).eq("state", "completed"),
        supabase.from("workflow_runs").select("*", { count: "exact", head: true }).eq("state", "failed"),
        supabase.from("workflow_templates").select("*", { count: "exact", head: true }),
        supabase.from("template_installs").select("*", { count: "exact", head: true }),
      ]);
      setStats({
        runs: runs.count ?? 0, completed: completed.count ?? 0, failed: failed.count ?? 0,
        templates: templates.count ?? 0, installs: installs.count ?? 0,
      });
    })();
  }, []);

  if (!stats) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const successRate = stats.runs ? Math.round((stats.completed / stats.runs) * 100) : 0;

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card><CardHeader><CardTitle className="text-sm">Workflow runs</CardTitle></CardHeader>
        <CardContent className="text-3xl font-display">{stats.runs}</CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Success rate</CardTitle></CardHeader>
        <CardContent className="text-3xl font-display">{successRate}%</CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Failed</CardTitle></CardHeader>
        <CardContent className="text-3xl font-display">{stats.failed}</CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Templates available</CardTitle></CardHeader>
        <CardContent className="text-3xl font-display">{stats.templates}</CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Template installs</CardTitle></CardHeader>
        <CardContent className="text-3xl font-display">{stats.installs}</CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Adoption</CardTitle></CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Metrics derive from real workflow_runs and template_installs telemetry — no synthetic data.
        </CardContent></Card>
    </div>
  );
}
