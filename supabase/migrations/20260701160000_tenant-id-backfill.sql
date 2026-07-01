-- ============================================================
-- tenant_id backfill: run-linked child tables
-- ============================================================
-- Phase 14 set every NULL tenant_id to the default tenant using a flat
-- UPDATE. That is wrong for multi-tenant installations: child rows inherit
-- tenant_id from their parent workflow_run.
--
-- This migration re-derives tenant_id from the parent run (join-based)
-- for all three run-linked tables, then falls back to the default tenant
-- for any truly orphaned rows, and finally asserts that no run-linked row
-- still has a NULL tenant_id.
-- ============================================================

-- ------------------------------------------------------------
-- Step 1: workflow_step_runs ← workflow_runs (via run_id)
-- ------------------------------------------------------------
UPDATE public.workflow_step_runs sr
SET    tenant_id = r.tenant_id
FROM   public.workflow_runs r
WHERE  sr.run_id     = r.id
  AND  r.tenant_id   IS NOT NULL
  AND  sr.tenant_id  IS NULL;

-- ------------------------------------------------------------
-- Step 2: workflow_events ← workflow_runs (via run_id, where linked)
-- ------------------------------------------------------------
UPDATE public.workflow_events e
SET    tenant_id = r.tenant_id
FROM   public.workflow_runs r
WHERE  e.run_id    = r.id
  AND  r.tenant_id IS NOT NULL
  AND  e.tenant_id IS NULL;

-- ------------------------------------------------------------
-- Step 3: workflow_incidents ← workflow_runs (via run_id, where linked)
-- ------------------------------------------------------------
UPDATE public.workflow_incidents i
SET    tenant_id = r.tenant_id
FROM   public.workflow_runs r
WHERE  i.run_id    = r.id
  AND  r.tenant_id IS NOT NULL
  AND  i.tenant_id IS NULL;

-- ------------------------------------------------------------
-- Step 4: fallback — rows whose parent run also has no tenant_id,
-- or fully orphaned rows (run_id IS NULL) → assign default tenant
-- ------------------------------------------------------------
UPDATE public.workflow_step_runs
SET    tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE  tenant_id IS NULL;

UPDATE public.workflow_events
SET    tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE  tenant_id IS NULL;

UPDATE public.workflow_incidents
SET    tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE  tenant_id IS NULL;

-- ------------------------------------------------------------
-- Step 5: assert — no run-linked row may remain NULL
-- ------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  -- workflow_step_runs: all rows have a run_id FK (NOT NULL); none may be NULL.
  SELECT count(*) INTO n
  FROM   public.workflow_step_runs
  WHERE  tenant_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'BACKFILL ASSERT FAILED: % workflow_step_runs still have NULL tenant_id', n;
  END IF;

  -- workflow_events: only run-linked rows are checked.
  SELECT count(*) INTO n
  FROM   public.workflow_events
  WHERE  run_id IS NOT NULL
    AND  tenant_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'BACKFILL ASSERT FAILED: % workflow_events linked to runs still have NULL tenant_id', n;
  END IF;

  -- workflow_incidents: only run-linked rows are checked.
  SELECT count(*) INTO n
  FROM   public.workflow_incidents
  WHERE  run_id IS NOT NULL
    AND  tenant_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'BACKFILL ASSERT FAILED: % workflow_incidents linked to runs still have NULL tenant_id', n;
  END IF;
END $$;
