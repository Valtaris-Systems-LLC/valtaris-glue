// supabase/functions/run-worker/index.ts
// Valtaris Glue — Manual Worker Trigger
//
// This Edge Function manually triggers the worker runtime.
// It is used for:
// - operator console actions
// - debugging workflow execution
// - forcing job processing
// - manual recovery
//
// It simply calls the worker function and returns its result.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

function getWorkerUrl(): string {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!base || !key) {
    throw new Error("Missing Supabase environment variables");
  }

  return `${base}/functions/v1/worker`;
}

async function triggerWorker(): Promise<any> {
  try {
    const res = await fetch(getWorkerUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({ reason: "manual_trigger" }),
    });

    return await res.json();
  } catch (err) {
    return {
      error: "worker.trigger_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

serve(async () => {
  const result = await triggerWorker();

  return new Response(
    JSON.stringify({
      triggeredAt: new Date().toISOString(),
      result,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
