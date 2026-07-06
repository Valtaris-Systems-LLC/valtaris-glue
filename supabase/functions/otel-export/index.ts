// OpenTelemetry-compatible export endpoint.
// Returns recent trace_spans + telemetry_aggregates in OTLP-ish JSON shape
// so external collectors (Datadog/Grafana/Honeycomb/New Relic) can scrape.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { authorizeEndpointRequest } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const access = await authorizeEndpointRequest(req, "otel-export");
  if (!access.ok) {
    return new Response(JSON.stringify({ error: access.error }), {
      status: access.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);
  const sinceMin = Number(url.searchParams.get("since_minutes") ?? "5");
  const since = new Date(Date.now() - sinceMin * 60_000).toISOString();

  const [{ data: spans }, { data: metrics }] = await Promise.all([
    sb.from("trace_spans").select("*").gte("started_at", since).order("started_at", { ascending: false }).limit(500),
    sb.from("telemetry_aggregates").select("*").gte("window_start", since).order("window_start", { ascending: false }).limit(500),
  ]);

  const resourceSpans = [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "api-glue" } }] },
    scopeSpans: [{
      scope: { name: "api-glue.runtime" },
      spans: (spans ?? []).map(s => ({
        traceId: s.trace_id,
        spanId: s.span_id,
        parentSpanId: s.parent_span_id ?? undefined,
        name: s.name,
        kind: s.kind,
        startTimeUnixNano: new Date(s.started_at).getTime() * 1_000_000,
        endTimeUnixNano: s.ended_at ? new Date(s.ended_at).getTime() * 1_000_000 : undefined,
        status: { code: s.status === "ok" ? 1 : 2 },
        attributes: Object.entries(s.attributes ?? {}).map(([k, v]) => ({
          key: k, value: { stringValue: String(v) },
        })),
      })),
    }],
  }];

  const resourceMetrics = [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "api-glue" } }] },
    scopeMetrics: [{
      scope: { name: "api-glue.runtime" },
      metrics: (metrics ?? []).map(m => ({
        name: `apiglue.${m.metric}`,
        unit: m.metric.includes("latency") ? "ms" : "1",
        gauge: { dataPoints: [{
          timeUnixNano: new Date(m.window_start).getTime() * 1_000_000,
          asDouble: Number(m.value),
          attributes: [{ key: "scope", value: { stringValue: m.scope } }],
        }] },
      })),
    }],
  }];

  return new Response(JSON.stringify({ resourceSpans, resourceMetrics }, null, 2), {
    status: 200, headers: { ...cors, "Content-Type": "application/json" },
  });
});
