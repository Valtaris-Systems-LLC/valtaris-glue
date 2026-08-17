// Shared connector adapter layer.
//
// Every step execution flows through Connector.execute(input) -> ConnectorResult.
// Adapters own timeout, auth detection, latency measurement, structured errors,
// quota touch, and health-check hooks.
//
// Compensation is deliberately separate from normal execution:
// ConnectorCompensator.compensate(context) is used by rollback-executor.
// A connector without a safe compensation contract returns null from
// getCompensator() and rollback fails closed.
//
// Workers never speak to connectors directly.

export type ErrorKind =
  | "timeout"
  | "auth"
  | "rate_limit"
  | "upstream_5xx"
  | "upstream_4xx"
  | "validation"
  | "unknown";

export interface ConnectorError {
  kind: ErrorKind;
  retryable: boolean;
  message: string;
  status?: number;
}

export interface ConnectorResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: ConnectorError;
  latency_ms: number;
  mock: boolean;
  connector: string;
  action: string;
}

export interface ConnectorAdapter {
  name: string;

  /** Returns true if live credentials are present. */
  hasCredentials(): boolean;

  /** Execute one forward action with a hard timeout. */
  execute(
    action: string,
    input: Record<string, unknown>,
    opts?: {
      timeoutMs?: number;
      idempotencyKey?: string;
    },
  ): Promise<ConnectorResult>;

  /** Cheap probe used by connector_state ticker. */
  healthCheck?(): Promise<{
    ok: boolean;
    latency_ms: number;
    error?: string;
  }>;
}

export interface CompensationContext {
  run_id: string;
  step_run_id: string;
  dag_node_id: string | null;
  workflow_version_id: string | null;
  idempotency_key: string;
  original_outputs: Record<string, unknown>;
  connector_response: Record<string, unknown>;
  requested_by: string;
  reason: string;
}

export interface CompensationResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ConnectorCompensator {
  compensate(
    context: CompensationContext,
  ): Promise<CompensationResult>;
}

// ─── utilities ────────────────────────────────────────────

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(`timeout after ${ms}ms`),
      );
    }, ms);

    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function classifyHttp(
  status: number,
  body: string,
): ConnectorError {
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      retryable: false,
      status,
      message: body.slice(0, 200),
    };
  }

  if (status === 429) {
    return {
      kind: "rate_limit",
      retryable: true,
      status,
      message: body.slice(0, 200),
    };
  }

  if (status >= 500) {
    return {
      kind: "upstream_5xx",
      retryable: true,
      status,
      message: body.slice(0, 200),
    };
  }

  if (status >= 400) {
    return {
      kind: "upstream_4xx",
      retryable: false,
      status,
      message: body.slice(0, 200),
    };
  }

  return {
    kind: "unknown",
    retryable: false,
    status,
    message: body.slice(0, 200),
  };
}

async function runAdapter(
  connector: string,
  action: string,
  hasCreds: boolean,
  liveFn: () => Promise<Response>,
  mockFn: () => Record<string, unknown>,
  timeoutMs: number,
): Promise<ConnectorResult> {
  const t0 = Date.now();

  if (!hasCreds) {
    // Cheap simulated latency so mock mode is not instantaneous
    // while remaining bounded.
    await new Promise((r) =>
      setTimeout(
        r,
        80 + Math.random() * 220,
      )
    );

    return {
      ok: true,
      data: mockFn(),
      latency_ms: Date.now() - t0,
      mock: true,
      connector,
      action,
    };
  }

  try {
    const resp = await withTimeout(
      liveFn(),
      timeoutMs,
    );

    const text = await resp.text();

    let body: unknown = text;

    try {
      body = JSON.parse(text);
    } catch {
      // Keep raw text when upstream does not return JSON.
    }

    if (!resp.ok) {
      return {
        ok: false,
        error: classifyHttp(
          resp.status,
          text,
        ),
        latency_ms:
          Date.now() - t0,
        mock: false,
        connector,
        action,
      };
    }

    return {
      ok: true,
      data:
        body as Record<
          string,
          unknown
        >,
      latency_ms:
        Date.now() - t0,
      mock: false,
      connector,
      action,
    };
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.message
        : String(e);

    const kind: ErrorKind =
      msg.startsWith("timeout")
        ? "timeout"
        : "unknown";

    return {
      ok: false,
      error: {
        kind,
        retryable:
          kind === "timeout",
        message: msg,
      },
      latency_ms:
        Date.now() - t0,
      mock: false,
      connector,
      action,
    };
  }
}

// ─── Stripe ───────────────────────────────────────────────

const stripe: ConnectorAdapter = {
  name: "stripe",

  hasCredentials: () =>
    !!Deno.env.get("STRIPE_KEY"),

  execute(
    action,
    input,
    opts,
  ) {
    const key =
      Deno.env.get("STRIPE_KEY");

    return runAdapter(
      "stripe",
      action,
      !!key,
      () => {
        const endpoints: Record<
          string,
          string
        > = {
          charge:
            "https://api.stripe.com/v1/charges",
          refund:
            "https://api.stripe.com/v1/refunds",
          createCustomer:
            "https://api.stripe.com/v1/customers",
        };

        const endpoint =
          endpoints[action];

        if (!endpoint) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error:
                  `unsupported Stripe action: ${action}`,
              }),
              {
                status: 400,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            ),
          );
        }

        const params =
          new URLSearchParams(
            Object.entries(
              input,
            ).reduce(
              (
                acc,
                [k, v],
              ) => {
                acc[k] = String(v);
                return acc;
              },
              {} as Record<
                string,
                string
              >,
            ),
          );

        return fetch(
          endpoint,
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${key}`,
              "Content-Type":
                "application/x-www-form-urlencoded",
              ...(opts?.idempotencyKey
                ? {
                    "Idempotency-Key":
                      opts.idempotencyKey,
                  }
                : {}),
            },
            body: params,
          },
        );
      },
      () => ({
        id:
          "ch_mock_" +
          Date.now(),
        amount:
          input.amount ??
          1000,
        currency:
          input.currency ??
          "usd",
        status:
          "succeeded",
      }),
      opts?.timeoutMs ??
        5000,
    );
  },
};

// Stripe compensation.
//
// Supported compensation:
//   charge -> refund
//
// The compensation contract requires the original Stripe charge/payment
// identifier to be present in persisted source outputs or connector response.
// If no identifier is available, compensation fails closed.
//
// Stripe's own idempotency key is propagated so repeated rollback attempts
// cannot intentionally create duplicate refund operations.

const stripeCompensator: ConnectorCompensator = {
  async compensate(
    context,
  ): Promise<CompensationResult> {
    const key =
      Deno.env.get("STRIPE_KEY");

    if (!key) {
      return {
        ok: false,
        error:
          "Stripe compensation requires STRIPE_KEY",
      };
    }

    const original =
      context.original_outputs ??
      {};

    const response =
      context.connector_response ??
      {};

    const chargeId =
      firstString(
        original,
        [
          "charge_id",
          "charge",
          "id",
        ],
      ) ??
      firstString(
        response,
        [
          "charge_id",
          "charge",
          "id",
        ],
      );

    if (!chargeId) {
      return {
        ok: false,
        error:
          "Stripe compensation requires original charge identifier",
      };
    }

    const amount =
      firstNumber(
        original,
        ["amount"],
      ) ??
      firstNumber(
        response,
        ["amount"],
      );

    const currency =
      firstString(
        original,
        ["currency"],
      ) ??
      firstString(
        response,
        ["currency"],
      );

    const params =
      new URLSearchParams();

    params.set(
      "charge",
      chargeId,
    );

    if (
      typeof amount ===
      "number"
    ) {
      params.set(
        "amount",
        String(amount),
      );
    }

    if (currency) {
      params.set(
        "currency",
        currency,
      );
    }

    try {
      const response =
        await withTimeout(
          fetch(
            "https://api.stripe.com/v1/refunds",
            {
              method: "POST",
              headers: {
                Authorization:
                  `Bearer ${key}`,
                "Content-Type":
                  "application/x-www-form-urlencoded",
                "Idempotency-Key":
                  context.idempotency_key,
              },
              body: params,
            },
          ),
          10000,
        );

      const text =
        await response.text();

      let body: unknown =
        text;

      try {
        body =
          JSON.parse(text);
      } catch {
        // Keep raw text below.
      }

      if (!response.ok) {
        const error =
          classifyHttp(
            response.status,
            text,
          );

        return {
          ok: false,
          error:
            `Stripe refund failed (${error.status ?? "unknown"}): ${error.message}`,
        };
      }

      return {
        ok: true,
        data:
          body as Record<
            string,
            unknown
          >,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  },
};

// ─── OpenAI ───────────────────────────────────────────────

const openai: ConnectorAdapter = {
  name: "openai",

  hasCredentials: () =>
    !!Deno.env.get("OPENAI_KEY") ||
    !!Deno.env.get(
      "LOVABLE_API_KEY",
    ),

  execute(
    action,
    input,
    opts,
  ) {
    const lovableKey =
      Deno.env.get(
        "LOVABLE_API_KEY",
      );

    const openaiKey =
      Deno.env.get(
        "OPENAI_KEY",
      );

    const useGateway =
      !!lovableKey &&
      !openaiKey;

    const key =
      openaiKey ??
      lovableKey;

    return runAdapter(
      "openai",
      action,
      !!key,
      () => {
        const url =
          useGateway
            ? "https://ai.gateway.lovable.dev/v1/chat/completions"
            : "https://api.openai.com/v1/chat/completions";

        return fetch(
          url,
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${key}`,
              "Content-Type":
                "application/json",
            },
            body:
              JSON.stringify({
                model:
                  input.model ??
                  (useGateway
                    ? "google/gemini-2.5-flash"
                    : "gpt-4o-mini"),
                messages: [
                  {
                    role: "user",
                    content:
                      String(
                        input.prompt ??
                          "Summarize the operation.",
                      ),
                  },
                ],
                max_tokens:
                  input.maxTokens ??
                  200,
              }),
          },
        );
      },
      () => ({
        text:
          `Receipt for ${
            input.correlation_id ??
            "op"
          } generated.`,
        model: "mock",
        confidence:
          0.55 +
          Math.random() *
            0.42,
      }),
      opts?.timeoutMs ??
        8000,
    );
  },
};

// ─── SendGrid ─────────────────────────────────────────────

const sendgrid: ConnectorAdapter = {
  name: "sendgrid",

  hasCredentials: () =>
    !!Deno.env.get(
      "SENDGRID_KEY",
    ),

  execute(
    action,
    input,
    opts,
  ) {
    const key =
      Deno.env.get(
        "SENDGRID_KEY",
      );

    return runAdapter(
      "sendgrid",
      action,
      !!key,
      () =>
        fetch(
          "https://api.sendgrid.com/v3/mail/send",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${key}`,
              "Content-Type":
                "application/json",
            },
            body:
              JSON.stringify({
                personalizations: [
                  {
                    to: [
                      {
                        email:
                          input.to ??
                          "noop@example.com",
                      },
                    ],
                    subject:
                      input.subject ??
                      "Notification",
                  },
                ],
                from: {
                  email:
                    input.from ??
                    "ops@apiglue.dev",
                },
                content: [
                  {
                    type:
                      "text/plain",
                    value:
                      String(
                        input.body ??
                          "Operation completed.",
                      ),
                  },
                ],
              }),
          },
        ),
      () => ({
        sent: true,
        to:
          input.to ??
          "noop@example.com",
      }),
      opts?.timeoutMs ??
        4000,
    );
  },
};

// ─── Twilio ───────────────────────────────────────────────

const twilio: ConnectorAdapter = {
  name: "twilio",

  hasCredentials: () =>
    !!Deno.env.get(
      "TWILIO_SID",
    ) &&
    !!Deno.env.get(
      "TWILIO_TOKEN",
    ),

  execute(
    action,
    input,
    opts,
  ) {
    const sid =
      Deno.env.get(
        "TWILIO_SID",
      );

    const token =
      Deno.env.get(
        "TWILIO_TOKEN",
      );

    const from =
      Deno.env.get(
        "TWILIO_PHONE",
      );

    return runAdapter(
      "twilio",
      action,
      !!sid && !!token,
      () =>
        fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization:
                `Basic ${btoa(
                  `${sid}:${token}`,
                )}`,
              "Content-Type":
                "application/x-www-form-urlencoded",
            },
            body:
              new URLSearchParams({
                To: String(
                  input.to ??
                    "",
                ),
                From: String(
                  input.from ??
                    from ??
                    "",
                ),
                Body: String(
                  input.body ??
                    "",
                ),
              }),
          },
        ),
      () => ({
        sid:
          "SM_mock_" +
          Date.now(),
        status: "queued",
        to:
          input.to ??
          "+10000000000",
      }),
      opts?.timeoutMs ??
        4000,
    );
  },
};

// ─── Slack ────────────────────────────────────────────────

const slack: ConnectorAdapter = {
  name: "slack",

  hasCredentials: () =>
    !!Deno.env.get(
      "SLACK_BOT_TOKEN",
    ),

  execute(
    action,
    input,
    opts,
  ) {
    const key =
      Deno.env.get(
        "SLACK_BOT_TOKEN",
      );

    return runAdapter(
      "slack",
      action,
      !!key,
      () =>
        fetch(
          "https://slack.com/api/chat.postMessage",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${key}`,
              "Content-Type":
                "application/json; charset=utf-8",
            },
            body:
              JSON.stringify({
                channel:
                  input.channel ??
                  "#ops",
                text:
                  input.text ??
                  "Workflow event",
              }),
          },
        ),
      () => ({
        ok: true,
        ts: String(
          Date.now() /
            1000,
        ),
        channel:
          input.channel ??
          "#ops",
      }),
      opts?.timeoutMs ??
        4000,
    );
  },
};

// ─── Salesforce ───────────────────────────────────────────

const salesforce: ConnectorAdapter = {
  name: "salesforce",

  hasCredentials: () =>
    !!Deno.env.get(
      "SALESFORCE_ACCESS_TOKEN",
    ) &&
    !!Deno.env.get(
      "SALESFORCE_INSTANCE_URL",
    ),

  execute(
    action,
    input,
    opts,
  ) {
    const token =
      Deno.env.get(
        "SALESFORCE_ACCESS_TOKEN",
      );

    const instance =
      Deno.env.get(
        "SALESFORCE_INSTANCE_URL",
      );

    return runAdapter(
      "salesforce",
      action,
      !!token && !!instance,
      () =>
        fetch(
          `${instance}/services/data/v60.0/sobjects/${
            input.object ??
            "Account"
          }`,
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${token}`,
              "Content-Type":
                "application/json",
            },
            body:
              JSON.stringify(
                input.fields ??
                  {},
              ),
          },
        ),
      () => ({
        id:
          "sf_mock_" +
          Date.now(),
        object:
          input.object ??
          "Account",
      }),
      opts?.timeoutMs ??
        6000,
    );
  },
};

// ─── Internal ─────────────────────────────────────────────

const internal: ConnectorAdapter = {
  name: "internal",

  hasCredentials: () =>
    true,

  async execute(
    action,
    input,
  ) {
    const t0 =
      Date.now();

    await new Promise(
      (r) =>
        setTimeout(
          r,
          40 +
            Math.random() *
              80,
        ),
    );

    return {
      ok: true,
      data: {
        validated: true,
        action,
        echo: input,
      },
      latency_ms:
        Date.now() - t0,
      mock: false,
      connector:
        "internal",
      action,
    };
  },
};

// ─── Connector registry ──────────────────────────────────

const REGISTRY: Record<
  string,
  ConnectorAdapter
> = {
  stripe,
  openai,
  sendgrid,
  twilio,
  slack,
  salesforce,
  internal,
};

export function getConnector(
  name: string,
): ConnectorAdapter {
  return (
    REGISTRY[name] ??
    internal
  );
}

export const CONNECTOR_NAMES =
  Object.keys(REGISTRY);

// ─── Compensation registry ───────────────────────────────
//
// Only connectors with an explicitly implemented and safe
// compensation contract are registered here.
//
// Returning null is intentional: rollback-executor fails closed
// instead of pretending an unsupported operation was reversed.

const COMPENSATOR_REGISTRY: Record<
  string,
  ConnectorCompensator
> = {
  stripe:
    stripeCompensator,
};

export function getCompensator(
  name: string,
): ConnectorCompensator | null {
  return (
    COMPENSATOR_REGISTRY[
      name
    ] ?? null
  );
}

export const COMPENSATABLE_CONNECTOR_NAMES =
  Object.keys(
    COMPENSATOR_REGISTRY,
  );

// ─── compensation helpers ────────────────────────────────

function firstString(
  source: Record<
    string,
    unknown
  >,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value =
      source[key];

    if (
      typeof value ===
        "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return null;
}

function firstNumber(
  source: Record<
    string,
    unknown
  >,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value =
      source[key];

    if (
      typeof value ===
        "number" &&
      Number.isFinite(value)
    ) {
      return value;
    }

    if (
      typeof value ===
        "string" &&
      value.trim() !== ""
    ) {
      const parsed =
        Number(value);

      if (
        Number.isFinite(
          parsed,
        )
      ) {
        return parsed;
      }
    }
  }

  return null;
}
