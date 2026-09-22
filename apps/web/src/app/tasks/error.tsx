'use client';

import { RouteError } from '@/components/route-error';

export default function TasksError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} subject="The task list" />;
}
