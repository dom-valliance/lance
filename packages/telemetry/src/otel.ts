import { AzureMonitorTraceExporter } from '@azure/monitor-opentelemetry-exporter';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * Resource attribute for the deployment environment (dev, staging, live).
 * The stable semantic conventions package renamed this attribute to
 * `deployment.environment.name`; spec section 13 specifies the original
 * `deployment.environment`, so it is declared literally rather than
 * imported.
 */
const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

export interface TelemetryConfig {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
}

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

let activeHandle: TelemetryHandle | undefined;
let activeSdk: NodeSDK | undefined;

/**
 * Chooses the trace exporter per spec section 13: Application Insights when
 * `APPLICATIONINSIGHTS_CONNECTION_STRING` is set, a console exporter in
 * local development, and no exporter otherwise (traces are still created
 * and can be read via the API, but nothing is sent anywhere).
 *
 * Never logs the connection string or any other configuration value.
 */
function selectTraceExporter(): SpanExporter | undefined {
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (connectionString) {
    return new AzureMonitorTraceExporter({ connectionString });
  }
  if (process.env.NODE_ENV === 'development') {
    return new ConsoleSpanExporter();
  }
  return undefined;
}

/**
 * Initialises the OpenTelemetry Node SDK for this process, instrumenting
 * HTTP and Postgres calls and tagging every span with `service.name`,
 * `service.version` and `deployment.environment`.
 *
 * The Node SDK is a process-wide singleton: calling this more than once
 * would either throw or double-register instrumentation, so a second call
 * is a no-op that returns the handle from the first call. Call
 * `shutdown()` on the returned handle to flush and stop the SDK; a further
 * `initTelemetry` call after that starts a fresh SDK instance.
 */
export function initTelemetry(config: TelemetryConfig): TelemetryHandle {
  if (activeHandle) {
    return activeHandle;
  }

  const traceExporter = selectTraceExporter();

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT]: config.environment,
    }),
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
    ...(traceExporter ? { traceExporter } : {}),
  });

  sdk.start();
  activeSdk = sdk;

  const handle: TelemetryHandle = {
    async shutdown(): Promise<void> {
      await activeSdk?.shutdown();
      activeSdk = undefined;
      activeHandle = undefined;
    },
  };
  activeHandle = handle;

  return handle;
}
