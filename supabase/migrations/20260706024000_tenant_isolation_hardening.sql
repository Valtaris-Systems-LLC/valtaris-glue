CREATE OR REPLACE FUNCTION public.has_any_admin_role(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_members
    WHERE user_id = _uid
      AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.can_read_tenant_row(_uid uuid, _tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN _tenant_id IS NULL THEN public.has_any_admin_role(_uid)
    ELSE public.has_tenant_access(_uid, _tenant_id)
  END;
$$;

CREATE OR REPLACE FUNCTION public.can_write_tenant_row(_uid uuid, _tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN _tenant_id IS NULL THEN public.has_any_admin_role(_uid)
    ELSE public.has_operator_role(_uid, _tenant_id, 'operator'::public.operator_role)
  END;
$$;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'workflow_runs',
    'workflow_step_runs',
    'workflow_events',
    'workflow_jobs',
    'workflow_checkpoints',
    'workflow_dead_letter',
    'workflow_incidents',
    'workflow_approvals',
    'workflow_rollbacks',
    'workflow_dags',
    'ai_decision_trace',
    'sla_breaches',
    'sla_policies',
    'telemetry_aggregates',
    'connector_state',
    'governance_policies',
    'queue_partitions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS "tenant members read" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "tenant members read" ON public.%I FOR SELECT TO authenticated USING (public.can_read_tenant_row(auth.uid(), tenant_id))',
      t
    );

    EXECUTE format('DROP POLICY IF EXISTS "tenant operators write" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "tenant operators write" ON public.%I FOR INSERT TO authenticated WITH CHECK (public.can_write_tenant_row(auth.uid(), tenant_id))',
      t
    );

    EXECUTE format('DROP POLICY IF EXISTS "tenant operators update" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "tenant operators update" ON public.%I FOR UPDATE TO authenticated USING (public.can_write_tenant_row(auth.uid(), tenant_id)) WITH CHECK (public.can_write_tenant_row(auth.uid(), tenant_id))',
      t
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS "tenant members read audit" ON public.runtime_audit_log;
CREATE POLICY "tenant members read audit" ON public.runtime_audit_log
  FOR SELECT TO authenticated
  USING (public.can_read_tenant_row(auth.uid(), tenant_id));

DROP POLICY IF EXISTS "any tenant member reads workers" ON public.worker_registry;
DROP POLICY IF EXISTS "demo open read" ON public.worker_registry;
DROP POLICY IF EXISTS "demo open write" ON public.worker_registry;
DROP POLICY IF EXISTS "demo open update" ON public.worker_registry;
DROP POLICY IF EXISTS "admins write workers" ON public.worker_registry;

CREATE POLICY "admins read workers" ON public.worker_registry
  FOR SELECT TO authenticated
  USING (public.has_any_admin_role(auth.uid()));

CREATE POLICY "admins write workers" ON public.worker_registry
  FOR ALL TO authenticated
  USING (public.has_any_admin_role(auth.uid()))
  WITH CHECK (public.has_any_admin_role(auth.uid()));

DROP POLICY IF EXISTS "any tenant member reads heartbeats" ON public.worker_heartbeats;
DROP POLICY IF EXISTS "demo open read" ON public.worker_heartbeats;
DROP POLICY IF EXISTS "demo open write" ON public.worker_heartbeats;
DROP POLICY IF EXISTS "demo open update" ON public.worker_heartbeats;

CREATE POLICY "admins read heartbeats" ON public.worker_heartbeats
  FOR SELECT TO authenticated
  USING (public.has_any_admin_role(auth.uid()));

DROP FUNCTION IF EXISTS public.runtime_health_report(uuid, boolean);
CREATE FUNCTION public.runtime_health_report(_tenant_id uuid, _include_worker_inventory boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r jsonb;
BEGIN
  SELECT jsonb_build_object(
    'workers_active',  CASE WHEN _include_worker_inventory THEN (SELECT count(*) FROM public.worker_registry WHERE health_state='active') ELSE 0 END,
    'workers_draining',CASE WHEN _include_worker_inventory THEN (SELECT count(*) FROM public.worker_registry WHERE health_state='draining') ELSE 0 END,
    'workers_offline', CASE WHEN _include_worker_inventory THEN (SELECT count(*) FROM public.worker_registry WHERE health_state='offline') ELSE 0 END,
    'queue_depth',     (SELECT count(*) FROM public.workflow_jobs WHERE tenant_id = _tenant_id AND state IN ('queued','retrying','delayed')),
    'in_flight',       (SELECT count(*) FROM public.workflow_jobs WHERE tenant_id = _tenant_id AND state IN ('claimed','running')),
    'dead_letter',     (SELECT count(*) FROM public.workflow_jobs WHERE tenant_id = _tenant_id AND state = 'dead_letter'),
    'paused_partitions',(SELECT count(*) FROM public.queue_partitions WHERE tenant_id = _tenant_id AND paused),
    'open_breaches',   (SELECT count(*) FROM public.sla_breaches WHERE tenant_id = _tenant_id AND resolved_at IS NULL),
    'open_incidents',  (SELECT count(*) FROM public.workflow_incidents WHERE tenant_id = _tenant_id AND closed_at IS NULL),
    'runs_running',    (SELECT count(*) FROM public.workflow_runs WHERE tenant_id = _tenant_id AND state NOT IN ('completed','failed')),
    'sampled_at',      now()
  ) INTO r;
  RETURN r;
END;
$$;
