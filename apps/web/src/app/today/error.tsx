'use client';

import { RouteError } from '@/components/route-error';

export default function TodayError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="The brief" />;
}
