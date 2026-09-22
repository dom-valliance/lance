'use client';

import { useState } from 'react';
import { Pause } from 'lucide-react';
import { ActionForm, type FormAction } from '@/components/action-form';
import { SubmitButton } from '@/components/submit-button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * The kill switch's arming step: the destructive button stays disabled
 * until a reason has been typed, so the pause that stops every watcher is
 * never one stray click away. The reason is held in client state only to
 * decide that; the server action reads it back from the form and validates
 * it again.
 */
export function PauseForm({ action }: { action: FormAction }) {
  const [reason, setReason] = useState('');
  return (
    <ActionForm action={action} className="flex flex-col gap-3">
      <Field label="Reason for pausing, required">
        <Input
          name="reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          required
          maxLength={200}
        />
      </Field>
      <SubmitButton
        variant="destructive"
        pendingLabel="Pausing"
        disabled={reason.trim() === ''}
        className="h-11 self-start lg:h-9"
      >
        <Pause aria-hidden />
        Pause Lance
      </SubmitButton>
    </ActionForm>
  );
}
