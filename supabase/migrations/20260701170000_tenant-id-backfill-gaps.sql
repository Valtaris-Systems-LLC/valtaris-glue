-- ============================================================
-- tenant_id backfill: workflow_dead_letter + approval-expired events
-- ============================================================
-- Fills the two tenant_id gaps identified in the post-patch re-audit:
--
--   Gap 1: workflow_dead_letter rows written by run-worker had no
--           tenant_id because the insert omitted the field.
--           (Fixed in run-worker/index.ts; this backfills existing rows.)
--
--   Gap 2: workflow_events rows with type='approval.expired' had no
--           tenant_id because expire_pending_approvals evt CTE did not
--           join workflow_runs.
--           (Fixed in 20260701154346_security-fixes.sql; this backfills
--           existing rows.)
--
-- Migration ordering:
--   Apply after 20260701160000_tenant-id-backfill.sql.
--   Depends on: workflow_dead_letter.tenant_id column (Phase 14),
--               workflow_runs.tenant_id column (Phase 14).
-- ============================================================

-- ------------------------------------------------------------
-- Gap 1: workflow_dead_letter ← workflow_runs (via run_id)
-- ------------------------------------------------------------
UPDATE public.workflow_dead_letter dl
SET    tenant_id = r.tenant_id
FROM   public.workflow_runs r
WHERE  dl.run_id    = r.id
  AND  r.tenant_id  IS NOT NULL
  AND  dl.tenant_id IS NULL;

-- Fallback: orphaned rows (parent run has no tenant_id, or run deleted)
UPDATE public.workflow_dead_letter
SET    tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE  tenant_id IS NULL;

-- ------------------------------------------------------------
-- Gap 2: approval-expired workflow_events ← workflow_runs (via run_id)
-- ------------------------------------------------------------
UPDATE public.workflow_events e
SET    tenant_id = r.tenant_id
FROM   public.workflow_runs r
WHERE  e.run_id    = r.id
  AND  e.type      = 'approval.expired'
  AND  r.tenant_id IS NOT NULL
  AND  e.tenant_id IS NULL;

-- Fallback: approval-expired events whose parent run has no tenant_id
UPDATE public.workflow_events
SET    tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE  type      = 'approval.expired'
  AND  tenant_id IS NULL;

-- ------------------------------------------------------------
-- Validation assertions — roll back if any gap remains
-- ------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  -- workflow_dead_letter: all run-linked rows must have tenant_id.
  SELECT count(*) INTO n
  FROM   public.workflow_dead_letter
  WHERE  run_id    IS NOT NULL
    AND  tenant_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'BACKFILL ASSERT FAILED: % workflow_dead_letter rows linked to runs still have NULL tenant_id', n;
  END IF;

  -- approval-expired workflow_events: all run-linked rows must have tenant_id.
  SELECT count(*) INTO n
  FROM   public.workflow_events
  WHERE  type      = 'approval.expired'
    AND  run_id    IS NOT NULL
    AND  tenant_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'BACKFILL ASSERT FAILED: % approval.expired workflow_events linked to runs still have NULL tenant_id', n;
  END IF;
END $$;
