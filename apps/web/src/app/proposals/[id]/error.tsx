'use client';

import { RouteError } from '@/components/route-error';

export default function ProposalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="The proposal" />;
}
