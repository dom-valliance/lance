'use client';

import { RouteError } from '@/components/route-error';

export default function SettingsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="Settings" />;
}
