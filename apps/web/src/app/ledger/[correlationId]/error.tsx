'use client';

import { RouteError } from '@/components/route-error';

export default function CorrelationError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="The trail" />;
}
