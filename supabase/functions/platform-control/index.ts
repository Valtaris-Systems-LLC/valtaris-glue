// platform-control — Phase 18 platform control plane.
// Actions: install_template, install_connector, complete_onboarding_step,
//          export_pack, import_pack, validate_deployment, save_dashboard.
// Tenant-scoped; operator-authenticated.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireUser, serviceClient, logSecurity } from "../_shared/auth.ts";

type Action =
  | "install_template" | "install_connector" | "complete_onboarding_step"
  | "export_pack" | "import_pack" | "validate_deployment" | "save_dashboard";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type TemplateVersionRow = {
  id: string;
  version: number;
  graph: Record<string, unknown>;
  required_connectors?: string[] | null;
};
type ValidationCheck = { name: string; ok: boolean; level: "pass" | "fail" | "warn"; detail: unknown };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = await requireUser(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const operator_uid = auth.ctx.userId;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const action: Action = body.action;
  if (!action) return json({ error: "action required" }, 400);

  const user = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth.ctx.authHeader } } },
  );
  const svc = serviceClient();

  try {
    switch (action) {
      case "install_template": {
        const { tenant_id, template_key, version } = body;
        if (!tenant_id || !template_key) return json({ error: "tenant_id, template_key required" }, 400);

        const { data: tmpl, error: te } = await user.from("workflow_templates")
          .select("id, name").eq("key", template_key).maybeSingle();
        if (te || !tmpl) return json({ error: "template not found" }, 404);

        let ver: TemplateVersionRow | null = null;
        if (version) {
          const r = await user.from("template_versions")
            .select("id, version, graph, required_connectors")
            .eq("template_id", tmpl.id).eq("version", version).maybeSingle();
          ver = r.data as TemplateVersionRow | null;
        } else {
          const r = await user.from("template_versions")
            .select("id, version, graph, required_connectors")
            .eq("template_id", tmpl.id).eq("state", "published")
            .order("version", { ascending: false }).limit(1).maybeSingle();
          ver = r.data as TemplateVersionRow | null;
          if (!ver) {
            // bootstrap an initial published version on first install so templates remain installable
            const { data: nv } = await svc.from("template_versions").insert({
              template_id: tmpl.id, version: 1, state: "published",
              graph: { nodes: [], edges: [] }, published_at: new Date().toISOString(),
            }).select("id, version, graph, required_connectors").single();
            ver = nv as TemplateVersionRow;
          }
        }

        const { data: ins, error: ie } = await user.from("template_installs").insert({
          tenant_id, template_id: tmpl.id, template_version_id: ver.id,
          installed_by: operator_uid, state: "installed",
        }).select("id").single();
        if (ie) throw ie;

        await svc.from("workflow_templates").update({ install_count: (tmpl.install_count ?? 0) + 1 })
          .eq("id", tmpl.id);
        await svc.from("runtime_audit_log").insert({
          tenant_id, actor: operator_uid, action: "template.install",
          subject_type: "template", subject_id: tmpl.id,
          details: { template_key, version: ver.version },
        });
        await logSecurity({ tenant_id, actor_user_id: operator_uid, category: "platform.install",
          subject_type: "template", subject_id: tmpl.id, message: `installed template ${template_key}` });
        return json({ install_id: ins.id, version: ver.version });
      }

      case "install_connector": {
        const { tenant_id, connector_key, config } = body;
        const { data: c } = await user.from("connector_catalog")
          .select("id").eq("key", connector_key).maybeSingle();
        if (!c) return json({ error: "connector not found" }, 404);
        const { data, error } = await user.from("connector_installations").insert({
          tenant_id, connector_id: c.id, config: config ?? {}, installed_by: operator_uid,
        }).select("id").single();
        if (error) throw error;
        await svc.from("runtime_audit_log").insert({
          tenant_id, actor: operator_uid, action: "connector.install",
          subject_type: "connector", subject_id: c.id, details: { connector_key },
        });
        return json({ installation_id: data.id });
      }

      case "complete_onboarding_step": {
        const { tenant_id, step_key } = body;
        const { error } = await user.from("onboarding_progress").upsert({
          tenant_id, step_key, state: "completed",
          completed_at: new Date().toISOString(), completed_by: operator_uid,
        }, { onConflict: "tenant_id,step_key" });
        if (error) throw error;
        return json({ ok: true });
      }

      case "export_pack": {
        const { tenant_id, key, name, workflow_definition_ids, connector_keys } = body;
        const manifest = {
          version: 1,
          workflow_definition_ids: workflow_definition_ids ?? [],
          connector_keys: connector_keys ?? [],
          exported_at: new Date().toISOString(),
          exported_by: operator_uid,
        };
        const { data, error } = await user.from("workflow_packs").insert({
          tenant_id, key, name, manifest,
          required_connectors: connector_keys ?? [], created_by: operator_uid,
        }).select("id, version").single();
        if (error) throw error;
        return json({ pack_id: data.id, version: data.version });
      }

      case "import_pack": {
        const { tenant_id, manifest } = body;
        if (!manifest) return json({ error: "manifest required" }, 400);

        // Validate connector compatibility
        const reqConns: string[] = manifest.connector_keys ?? [];
        const { data: avail } = await svc.from("connector_catalog")
          .select("key").in("key", reqConns.length ? reqConns : ["__none__"]);
        const availKeys = new Set((avail ?? []).map((r) => r.key));
        const missing = reqConns.filter((k) => !availKeys.has(k));

        const state = missing.length ? "failed" : "imported";
        const report = { missing_connectors: missing, validated_at: new Date().toISOString() };

        const { data, error } = await user.from("pack_imports").insert({
          tenant_id, source: "upload", manifest, state, validation_report: report,
          imported_by: operator_uid,
          imported_at: state === "imported" ? new Date().toISOString() : null,
        }).select("id").single();
        if (error) throw error;
        return json({ import_id: data.id, state, report });
      }

      case "validate_deployment": {
        const { tenant_id, profile_id } = body;
        const checks: ValidationCheck[] = [];
        let passed = 0, failed = 0, warnings = 0;

        const push = (name: string, ok: boolean, detail?: unknown, level: "fail" | "warn" = "fail") => {
          checks.push({ name, ok, level: ok ? "pass" : level, detail: detail ?? null });
          if (ok) passed++; else if (level === "warn") warnings++; else failed++;
        };

        const [{ count: connectorCount }, { count: webhookCount }, { count: wfCount }, { data: breakers }, { count: workerCount }] = await Promise.all([
          svc.from("connector_installations").select("*", { count: "exact", head: true }).eq("tenant_id", tenant_id).eq("enabled", true),
          svc.from("webhook_endpoints").select("*", { count: "exact", head: true }).eq("tenant_id", tenant_id).eq("active", true),
          svc.from("workflow_definitions").select("*", { count: "exact", head: true }).eq("tenant_id", tenant_id),
          svc.from("connector_circuit_breakers").select("connector,state").eq("state", "open"),
          svc.from("worker_registry").select("*", { count: "exact", head: true }).eq("health_state", "active"),
        ]);

        push("connectors.configured", (connectorCount ?? 0) > 0, { count: connectorCount });
        push("webhooks.registered", (webhookCount ?? 0) > 0, { count: webhookCount }, "warn");
        push("workflows.defined", (wfCount ?? 0) > 0, { count: wfCount });
        push("breakers.healthy", !(breakers && breakers.length), { open: breakers?.map((b) => b.connector) ?? [] });
        push("workers.active", (workerCount ?? 0) > 0, { count: workerCount });

        const state = failed > 0 ? "failed" : warnings > 0 ? "passed_with_warnings" : "passed";
        const { data, error } = await user.from("deployment_validations").insert({
          tenant_id, profile_id: profile_id ?? null, ran_by: operator_uid,
          state, checks, passed, failed, warnings,
        }).select("id").single();
        if (error) throw error;
        await svc.from("runtime_audit_log").insert({
          tenant_id, actor: operator_uid, action: "deployment.validate",
          subject_type: "deployment_profile", subject_id: profile_id ?? null,
          details: { state, passed, failed, warnings },
        });
        return json({ validation_id: data.id, state, passed, failed, warnings, checks });
      }

      case "save_dashboard": {
        const { tenant_id, name, layout, shared, id } = body;
        if (id) {
          const { error } = await user.from("saved_dashboards").update({
            name, layout, shared: !!shared,
          }).eq("id", id);
          if (error) throw error;
          return json({ ok: true, id });
        }
        const { data, error } = await user.from("saved_dashboards").insert({
          tenant_id, owner_user_id: operator_uid, name, layout: layout ?? {}, shared: !!shared,
        }).select("id").single();
        if (error) throw error;
        return json({ id: data.id });
      }

      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error)?.message ?? String(e) }, 400);
  }
});
