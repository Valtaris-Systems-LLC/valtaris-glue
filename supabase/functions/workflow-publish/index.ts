// workflow-publish — operator-authenticated workflow studio control plane.
// Actions: create_definition, save_draft, validate, publish, archive,
// rollback, create_draft_from_version, start_migration, complete_migration.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireUser, serviceClient, logSecurity } from "../_shared/auth.ts";

type Action =
  | "create_definition" | "save_draft" | "validate" | "publish"
  | "archive" | "rollback" | "create_draft_from_version"
  | "start_migration" | "complete_migration";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type CreateDefinitionPayload = { tenant_id?: string; key?: string; name?: string };
type SaveDraftPayload = { version_id?: string; graph?: Record<string, unknown>; metadata?: Record<string, unknown> };
type VersionIdPayload = { version_id?: string };
type RollbackPayload = { definition_id?: string; target_version_id?: string };
type DraftFromVersionPayload = { source_version_id?: string };
type StartMigrationPayload = { definition_id?: string; from_version_id?: string; to_version_id?: string; strategy?: string };
type CompleteMigrationPayload = { migration_id?: string; report?: Record<string, unknown> };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await requireUser(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const operator_uid = auth.ctx.userId;

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const action = payload.action as Action;
  if (!action) return json({ error: "action required" }, 400);

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth.ctx.authHeader } } },
  );
  const svc = serviceClient();

  try {
    switch (action) {
      case "create_definition": {
        const { tenant_id, key, name } = payload as CreateDefinitionPayload;
        if (!tenant_id || !key || !name) return json({ error: "tenant_id, key, name required" }, 400);
        const { data, error } = await userClient.rpc("create_workflow_definition", {
          _tenant_id: tenant_id, _key: key, _name: name, _operator_uid: operator_uid,
        });
        if (error) throw error;
        return json({ definition_id: data });
      }

      case "save_draft": {
        const { version_id, graph, metadata } = payload as SaveDraftPayload;
        if (!version_id || !graph) return json({ error: "version_id and graph required" }, 400);
        const { data: v } = await userClient.from("workflow_versions").select("state").eq("id", version_id).maybeSingle();
        if (!v) return json({ error: "version not found" }, 404);
        if (v.state !== "draft") return json({ error: "only draft versions are editable" }, 409);
        const patch: Record<string, unknown> = { graph };
        if (metadata !== undefined) patch.metadata = metadata;
        const { error } = await userClient.from("workflow_versions").update(patch).eq("id", version_id);
        if (error) throw error;
        return json({ ok: true });
      }

      case "validate": {
        const { version_id } = payload as VersionIdPayload;
        const { data, error } = await userClient.rpc("validate_workflow_version", { _version_id: version_id });
        if (error) throw error;
        return json(data);
      }

      case "publish": {
        const { version_id } = payload as VersionIdPayload;
        const { data, error } = await userClient.rpc("publish_workflow_version", {
          _version_id: version_id, _operator_uid: operator_uid,
        });
        if (error) throw error;
        await logSecurity({ actor_user_id: operator_uid, category: "operator.action",
          subject_type: "workflow_version", subject_id: version_id, message: "workflow published" });
        return json({ ok: true, report: data });
      }

      case "archive": {
        const { version_id } = payload as VersionIdPayload;
        const { error } = await userClient.rpc("archive_workflow_version", {
          _version_id: version_id, _operator_uid: operator_uid,
        });
        if (error) throw error;
        return json({ ok: true });
      }

      case "rollback": {
        const { definition_id, target_version_id } = payload as RollbackPayload;
        const { error } = await userClient.rpc("rollback_published_version", {
          _definition_id: definition_id,
          _target_version_id: target_version_id,
          _operator_uid: operator_uid,
        });
        if (error) throw error;
        return json({ ok: true });
      }

      case "create_draft_from_version": {
        const { source_version_id } = payload as DraftFromVersionPayload;
        const { data, error } = await userClient.rpc("create_draft_from_version", {
          _source_version_id: source_version_id, _operator_uid: operator_uid,
        });
        if (error) throw error;
        return json({ version_id: data });
      }

      case "start_migration": {
        const { definition_id, from_version_id, to_version_id, strategy } = payload as StartMigrationPayload;
        const { data: def } = await userClient.from("workflow_definitions").select("tenant_id").eq("id", definition_id).maybeSingle();
        if (!def) return json({ error: "definition not found" }, 404);
        const { data, error } = await userClient.from("workflow_migrations").insert({
          tenant_id: def.tenant_id, definition_id,
          from_version_id, to_version_id,
          strategy: strategy ?? "drain", state: "running", actor_user_id: operator_uid,
        }).select("id").single();
        if (error) throw error;
        await svc.from("workflow_events").insert({
          tenant_id: def.tenant_id, type: "workflow.migration.started", severity: "info",
          source: "workflow", message: `Migration started (${strategy ?? "drain"})`,
          data: { migration_id: data.id, definition_id, from_version_id, to_version_id },
        });
        return json({ migration_id: data.id });
      }

      case "complete_migration": {
        const { migration_id, report } = payload as CompleteMigrationPayload;
        const { data: m } = await userClient.from("workflow_migrations").select("tenant_id").eq("id", migration_id).maybeSingle();
        if (!m) return json({ error: "migration not found" }, 404);
        const { error } = await userClient.from("workflow_migrations").update({
          state: "completed", ended_at: new Date().toISOString(), report: report ?? {},
        }).eq("id", migration_id);
        if (error) throw error;
        await svc.from("workflow_events").insert({
          tenant_id: m.tenant_id, type: "workflow.migration.completed", severity: "info",
          source: "workflow", message: "Migration completed",
          data: { migration_id, report: report ?? {} },
        });
        return json({ ok: true });
      }

      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return json({ error: msg }, 400);
  }
});
