// Platform store — Phase 18: templates, marketplace, onboarding, packs, deployments.
// Reads tenant-scoped platform tables and exposes operator actions via platform-control.
import { create } from "zustand";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

export interface TemplateCategory { key: string; name: string; description: string | null; sort_order: number }
export interface WorkflowTemplate {
  id: string; key: string; name: string; summary: string | null;
  category_key: string | null; tags: string[]; featured: boolean;
  install_count: number; state: string;
}
export interface ConnectorCatalogEntry {
  id: string; key: string; name: string; category: string | null;
  description: string | null; auth_model: string; featured: boolean;
}
export interface OnboardingStep {
  key: string; title: string; description: string | null;
  category: string; required: boolean; sort_order: number;
}
export interface OnboardingProgressRow {
  step_key: string; state: string; completed_at: string | null;
}
export interface DeploymentValidation {
  id: string; state: string; passed: number; failed: number; warnings: number;
  ran_at: string; checks: Json[];
}

interface PlatformState {
  categories: TemplateCategory[];
  templates: WorkflowTemplate[];
  connectors: ConnectorCatalogEntry[];
  onboardingSteps: OnboardingStep[];
  progress: OnboardingProgressRow[];
  validations: DeploymentValidation[];
  installs: { template_id: string; installed_at: string }[];
  loading: boolean;
  load: () => Promise<void>;
  install: (templateKey: string, tenant_id: string) => Promise<{ ok: boolean; error?: string }>;
  installConnector: (connector_key: string, tenant_id: string) => Promise<{ ok: boolean; error?: string }>;
  completeStep: (step_key: string, tenant_id: string) => Promise<void>;
  validateDeployment: (tenant_id: string, profile_id?: string) => Promise<DeploymentValidation | null>;
}

async function invoke(action: string, payload: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("platform-control", { body: { action, ...payload } });
  if (error) return { error: error.message };
  if (data?.error) return { error: data.error };
  return data;
}

export const usePlatform = create<PlatformState>((set, get) => ({
  categories: [], templates: [], connectors: [],
  onboardingSteps: [], progress: [], validations: [], installs: [],
  loading: false,

  async load() {
    set({ loading: true });
    const [cats, tmpls, conns, steps, progress, validations, installs] = await Promise.all([
      supabase.from("template_categories").select("*").order("sort_order"),
      supabase.from("workflow_templates").select("*").order("featured", { ascending: false }),
      supabase.from("connector_catalog").select("*").order("featured", { ascending: false }),
      supabase.from("onboarding_steps").select("*").order("sort_order"),
      supabase.from("onboarding_progress").select("step_key,state,completed_at"),
      supabase.from("deployment_validations").select("id,state,passed,failed,warnings,ran_at,checks").order("ran_at", { ascending: false }).limit(10),
      supabase.from("template_installs").select("template_id,installed_at"),
    ]);
    set({
      categories: (cats.data ?? []) as TemplateCategory[],
      templates: (tmpls.data ?? []) as WorkflowTemplate[],
      connectors: (conns.data ?? []) as ConnectorCatalogEntry[],
      onboardingSteps: (steps.data ?? []) as OnboardingStep[],
      progress: (progress.data ?? []) as OnboardingProgressRow[],
      validations: (validations.data ?? []) as DeploymentValidation[],
      installs: (installs.data ?? []) as { template_id: string; installed_at: string }[],
      loading: false,
    });
  },

  async install(template_key, tenant_id) {
    const r = await invoke("install_template", { template_key, tenant_id });
    if (r?.error) return { ok: false, error: r.error };
    await get().load();
    return { ok: true };
  },

  async installConnector(connector_key, tenant_id) {
    const r = await invoke("install_connector", { connector_key, tenant_id });
    if (r?.error) return { ok: false, error: r.error };
    await get().load();
    return { ok: true };
  },

  async completeStep(step_key, tenant_id) {
    await invoke("complete_onboarding_step", { step_key, tenant_id });
    await get().load();
  },

  async validateDeployment(tenant_id, profile_id) {
    const r = await invoke("validate_deployment", { tenant_id, profile_id });
    if (r?.error) return null;
    await get().load();
    return r as DeploymentValidation;
  },
}));
