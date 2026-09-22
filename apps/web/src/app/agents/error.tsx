'use client';

import { RouteError } from '@/components/route-error';

export default function AgentsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="Agent status" />;
}
