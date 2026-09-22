'use client';

import { RouteError } from '@/components/route-error';

export default function LedgerError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="The ledger" />;
}
