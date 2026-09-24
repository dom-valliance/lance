'use client';

import { RouteError } from '@/components/route-error';

export default function LinkSlackError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="Your Slack link" />;
}
