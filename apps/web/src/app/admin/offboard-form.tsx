'use client';

import { useState } from 'react';
import { ActionForm, type FormAction } from '@/components/action-form';
import { SubmitButton } from '@/components/submit-button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { offboardConfirmed } from '@/lib/admin-view';

/**
 * Offboarding one principal: the button stays disabled until their UPN
 * has been typed in full and a reason given, because the steps delete
 * their credentials and archive their channel. The server action and the
 * api check everything again.
 */
export function OffboardForm({
  action,
  principalId,
  upn,
}: {
  action: FormAction;
  principalId: string;
  upn: string;
}) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const ready = offboardConfirmed(typed, upn) && reason.trim() !== '';
  return (
    <ActionForm action={action} className="flex flex-col gap-3">
      <input type="hidden" name="principalId" value={principalId} />
      <Field label={`Type ${upn} to confirm`}>
        <Input
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="Reason, for the ledger">
        <Input
          name="reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          maxLength={500}
        />
      </Field>
      <SubmitButton
        variant="destructive"
        pendingLabel="Offboarding"
        disabled={!ready}
        className="h-11 self-start lg:h-9"
      >
        Offboard {upn}
      </SubmitButton>
    </ActionForm>
  );
}
