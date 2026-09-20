/**
 * Base URL of `apps/api`. WP0.8 provides the tRPC `AppRouter` this web shell
 * will eventually call; there is no tRPC client here yet, so callers use
 * this only to build plain URLs (for example the SSE endpoint in ./sse.ts).
 */
export function apiBaseUrl(): string {
  return process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
}
