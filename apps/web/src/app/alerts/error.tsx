'use client';

import { RouteError } from '@/components/route-error';

export default function AlertsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="The alerts list" />;
}
