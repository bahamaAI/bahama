import type { HttpClient, HttpRequest, HttpResponse } from "@bahama/provider-kit";
import type { Redactor } from "./redact.js";

const DEFAULT_TIMEOUT_MS = 60_000;

/** fetch-based HttpClient whose diagnostics are redacted before they escape. */
export class RedactingHttpClient implements HttpClient {
  constructor(
    private readonly deps: {
      redactor: Redactor;
      signal: AbortSignal;
      /** Extra headers applied to every request, e.g. an Authorization bearer. */
      headers?: () => Promise<Record<string, string>>;
    },
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = AbortSignal.any([this.deps.signal, timeout]);
    const baseHeaders = this.deps.headers ? await this.deps.headers() : {};

    let response: Response;
    try {
      response = await fetch(req.url, {
        method: req.method,
        headers: {
          accept: "application/json",
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
          ...baseHeaders,
          ...req.headers,
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(this.deps.redactor.redact(`HTTP ${req.method} ${req.url} failed: ${cause}`));
    }

    const bodyText = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const redactor = this.deps.redactor;
    return {
      status: response.status,
      headers,
      body: bodyText,
      json<T = unknown>(): T {
        try {
          return JSON.parse(bodyText) as T;
        } catch {
          throw new Error(
            redactor.redact(
              `HTTP ${req.method} ${req.url} returned non-JSON (status ${response.status}): ${bodyText.slice(0, 200)}`,
            ),
          );
        }
      },
    };
  }
}
