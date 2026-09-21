export type ConnectorName = 'graph' | 'jamie' | 'notion' | 'slack';

export interface ConnectorErrorOptions {
  connector: ConnectorName;
  operation: string;
  /** HTTP status when the failure came from a response. */
  status?: number;
  /** Whether a retry could succeed: network faults, 408, 429 and 5xx. */
  retryable: boolean;
  /** Seconds the remote asked us to wait, from Retry-After, when present. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

/** Every failure a connector surfaces. Never carries a request or response body. */
export class ConnectorError extends Error {
  override readonly name: string = 'ConnectorError';
  readonly connector: ConnectorName;
  readonly operation: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, options: ConnectorErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.connector = options.connector;
    this.operation = options.operation;
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Raised without calling the remote while the breaker is open. */
export class CircuitOpenError extends ConnectorError {
  override readonly name = 'CircuitOpenError';

  constructor(connector: ConnectorName, operation: string, reopensAt: Date) {
    super(
      `${connector} is unavailable: its circuit breaker is open until ${reopensAt.toISOString()} after repeated failures. Check the connector's alert and the remote service before retrying.`,
      { connector, operation, retryable: false },
    );
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function isConnectorError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError;
}
