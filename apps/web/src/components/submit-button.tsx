'use client';

import type { ComponentProps } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/**
 * A form's submit control that shows the loading state while its server
 * action runs: the spinner appears, the label switches to the progressive
 * form ("Approving") and the button refuses a second click.
 */
export function SubmitButton({
  pendingLabel,
  children,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={disabled === true || pending}
      aria-busy={pending}
      aria-disabled={disabled === true || pending}
      {...props}
    >
      {pending ? <Spinner /> : null}
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </Button>
  );
}
