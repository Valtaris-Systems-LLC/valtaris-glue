
-- ============================================================
-- SECURITY FIXES: C4 + H4
-- ============================================================

-- ============================================================
-- C4: expire_pending_approvals must not overwrite terminal jobs
-- ============================================================
-- Original bug: the jobs CTE unconditionally set state='dead_letter'
-- for any job linked to an expired approval, even if the job had
-- already reached a terminal state (completed / dead_letter / failed).
-- This could silently overwrite a completed job, breaking audit
-- integrity and downstream idempotency checks.
-- Fix: add AND j.state NOT IN ('completed','dead_letter','failed').
CREATE OR REPLACE FUNCTION public.expire_pending_approvals()
RETURNS TABLE(expired integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE n integer := 0;
BEGIN
  WITH ex AS (
    UPDATE public.workflow_approvals
    SET state = 'expired', decided_at = now(), decision = 'expire'
    WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at < now()
    RETURNING id, run_id, job_id, step_id
  ),
  jobs AS (
    UPDATE public.workflow_jobs j
    SET state = 'dead_letter', completed_at = now(), error = 'approval expired', updated_at = now()
    FROM ex
    WHERE j.id = ex.job_id
      AND j.state NOT IN ('completed', 'dead_letter', 'failed')
    RETURNING 1
  ),
  evt AS (
    INSERT INTO public.workflow_events(run_id, step_id, type, severity, source, message)
    SELECT run_id, step_id, 'approval.expired', 'warn', 'governance', 'Approval window expired'
    FROM ex
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ex;
  expired := n;
  RETURN NEXT;
END;
$$;

-- ============================================================
-- H4: sla_policies tenant_id must not be NULL
-- ============================================================
-- A tenant operator with the authenticated-user INSERT policy
-- could craft a request that bypasses the tenant_id IS NOT NULL
-- check, or a SECURITY DEFINER function could insert without
-- tenant_id, creating a "global" policy that matches every
-- tenant's workflow names.
-- Fix: backfill existing NULLs to the default tenant, then add
-- a NOT NULL constraint so no future path can insert NULL.

UPDATE public.sla_policies
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

ALTER TABLE public.sla_policies
  ALTER COLUMN tenant_id SET NOT NULL;
