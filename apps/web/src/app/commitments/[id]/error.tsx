'use client';

import { RouteError } from '@/components/route-error';

export default function CommitmentError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="The commitment" />;
}
