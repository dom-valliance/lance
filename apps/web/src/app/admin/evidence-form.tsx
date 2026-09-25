'use client';

import { useActionState, useEffect } from 'react';
import { InlineFailure } from '@/components/inline-failure';
import { SubmitButton } from '@/components/submit-button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { EvidenceState } from '@/app/admin/actions';

/**
 * The evidence export (spec 4.4): a period and, optionally, one principal.
 * The signed bundle comes back from the server action and is saved as a
 * file; a failure is shown under the form.
 */
export function EvidenceForm({
  action,
  principals,
  defaultFrom,
  defaultTo,
}: {
  action: (previous: EvidenceState, form: FormData) => Promise<EvidenceState>;
  principals: { id: string; upn: string }[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: 'idle' });

  useEffect(() => {
    if (state.status !== 'ready') return;
    const url = URL.createObjectURL(new Blob([state.body], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = state.filename;
    link.click();
    URL.revokeObjectURL(url);
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-3" aria-busy={pending}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First day">
          <Input type="date" name="from" defaultValue={defaultFrom} required />
        </Field>
        <Field label="Last day">
          <Input type="date" name="to" defaultValue={defaultTo} required />
        </Field>
      </div>
      <Field
        label="Principal"
        hint="Without a principal the bundle holds system events only: access, rule changes and retention runs."
      >
        <Select name="principalId" defaultValue="">
          <option value="">System events only</option>
          {principals.map((principal) => (
            <option key={principal.id} value={principal.id}>
              {principal.upn}
            </option>
          ))}
        </Select>
      </Field>
      <SubmitButton pendingLabel="Exporting" className="h-11 self-start lg:h-9">
        Export signed evidence
      </SubmitButton>
      {state.status === 'failed' ? <InlineFailure>{state.message}</InlineFailure> : null}
      {state.status === 'ready' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved {state.filename}.
        </p>
      ) : null}
    </form>
  );
}
