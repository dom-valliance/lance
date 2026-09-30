import {
  ConnectorError,
  isRetryableStatus,
  type ConnectorErrorOptions,
  type ConnectorName,
} from './errors.js';

export interface JsonRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** Sent as JSON, or form-encoded when it is a `URLSearchParams`. */
  body?: unknown;
  /** Aborts the request after this long. */
  timeoutMs?: number;
}

export interface JsonResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * The one HTTP helper every connector uses. Maps status codes to
 * `ConnectorError` with the right `retryable`, never includes the response
 * body in the error message (bodies can hold personal data), and treats a
 * 204 as an empty body.
 */
export async function fetchJson<T>(
  connector: ConnectorName,
  operation: string,
  url: string,
  request: JsonRequest = {},
  fetchImpl: typeof fetch = fetch,
): Promise<JsonResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000);
  let response: Response;
  try {
    const init: RequestInit = {
      method: request.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(request.body === undefined
          ? {}
          : {
              'content-type':
                request.body instanceof URLSearchParams
                  ? 'application/x-www-form-urlencoded'
                  : 'application/json',
            }),
        ...request.headers,
      },
      signal: controller.signal,
    };
    if (request.body instanceof URLSearchParams) init.body = request.body.toString();
    else if (request.body !== undefined) init.body = JSON.stringify(request.body);
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new ConnectorError(
      `${connector} ${operation}: network failure or timeout (${error instanceof Error ? error.name : 'unknown'}).`,
      { connector, operation, retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const options: ConnectorErrorOptions = {
      connector,
      operation,
      status: response.status,
      retryable: isRetryableStatus(response.status),
    };
    const retryAfterSeconds = retryAfter(response.headers);
    if (retryAfterSeconds !== undefined) options.retryAfterSeconds = retryAfterSeconds;
    throw new ConnectorError(`${connector} ${operation}: HTTP ${response.status}.`, options);
  }

  if (response.status === 204) {
    return { status: response.status, headers: response.headers, body: undefined as T };
  }
  const text = await response.text();
  if (text.length === 0) {
    return { status: response.status, headers: response.headers, body: undefined as T };
  }
  try {
    return { status: response.status, headers: response.headers, body: JSON.parse(text) as T };
  } catch (error) {
    throw new ConnectorError(`${connector} ${operation}: response was not JSON.`, {
      connector,
      operation,
      status: response.status,
      retryable: false,
      cause: error,
    });
  }
}
