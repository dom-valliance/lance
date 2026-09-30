'use client';

import { useState, type ReactNode } from 'react';
import { cn } from 'cn';
import { ActionForm, type FormAction } from '@/components/action-form';
import { Td, Tr, type RowAccent } from '@/components/data-table';
import { SubmitButton } from '@/components/submit-button';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { REJECT_REASONS } from '@/lib/proposal-view';

/**
 * Approve is one click; Reject needs a reason (spec 12, same as the
 * detail page's Decide card), and the reason field would crowd the
 * actions cell. Reject is an inline expansion beneath the row instead,
 * the same disclosure the commitments table uses for Drop
 * (`drop-disclosure.tsx`).
 */

/** The seven columns of the Proposals table the expansion spans. */
const COLUMN_COUNT = 7;

const CARD_ACCENT: Record<RowAccent, string> = {
  brand: 'shadow-[inset_2px_0_0_var(--brand)]',
  pink: 'shadow-[inset_2px_0_0_var(--sem-pink-fg)]',
  red: 'shadow-[inset_2px_0_0_var(--sem-red-fg)]',
};

function RejectForm({
  id,
  proposalId,
  action,
  onCancel,
}: {
  id: string;
  proposalId: string;
  action: FormAction;
  onCancel: () => void;
}) {
  return (
    <div id={id} className="flex flex-col gap-3 rounded-lg bg-muted/50 p-4">
      <ActionForm action={action} className="flex flex-col gap-3">
        <input type="hidden" name="proposalId" value={proposalId} />
        <Field label="Reason for rejecting, required" className="max-w-md">
          <Select name="reasonCode" required autoFocus defaultValue="">
            <option value="" disabled>
              Choose a reason
            </option>
            {REJECT_REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note, optional" className="max-w-md">
          <Textarea name="note" rows={2} placeholder="Anything Lance should learn from this" />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton variant="destructive" size="sm" pendingLabel="Rejecting">
            Reject this proposal
          </SubmitButton>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </ActionForm>
    </div>
  );
}

function RejectButton({
  open,
  panelId,
  size,
  onToggle,
}: {
  open: boolean;
  panelId: string;
  size: 'sm' | 'lg';
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      aria-expanded={open}
      aria-controls={panelId}
      onClick={onToggle}
    >
      Reject
    </Button>
  );
}

/** Approve, one click; a snooze form alongside it where the status allows one. */
function DecideActions({
  proposalId,
  size,
  approveAction,
  snoozeAction,
}: {
  proposalId: string;
  size: 'sm' | 'lg';
  approveAction: FormAction;
  snoozeAction: FormAction | null;
}) {
  return (
    <>
      <ActionForm action={approveAction} className={cn(size === 'lg' && 'flex-1')}>
        <input type="hidden" name="proposalId" value={proposalId} />
        <SubmitButton
          size={size}
          pendingLabel="Approving"
          className={cn(size === 'lg' && 'w-full')}
        >
          Approve
        </SubmitButton>
      </ActionForm>
      {snoozeAction === null ? null : (
        <ActionForm action={snoozeAction}>
          <input type="hidden" name="proposalId" value={proposalId} />
          <SubmitButton variant="outline" size={size} pendingLabel="Snoozing">
            Snooze 4h
          </SubmitButton>
        </ActionForm>
      )}
    </>
  );
}

/**
 * One decidable row and the Reject expansion under it. `children` is the
 * row's leading cells, rendered on the server; the actions cell and the
 * disclosure are added here so the toggle state can reach the sibling row.
 */
export function ProposalRowPair({
  proposalId,
  accent,
  approveAction,
  rejectAction,
  snoozeAction,
  children,
}: {
  proposalId: string;
  accent?: RowAccent;
  approveAction: FormAction;
  rejectAction: FormAction;
  snoozeAction: FormAction | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = `reject-${proposalId}`;
  const accentProp = accent === undefined ? {} : { accent };

  return (
    <>
      <Tr liveId={proposalId} {...accentProp}>
        {children}
        <Td>
          <div className="flex flex-wrap items-center gap-2">
            <DecideActions
              proposalId={proposalId}
              size="sm"
              approveAction={approveAction}
              snoozeAction={snoozeAction}
            />
            <RejectButton
              open={open}
              panelId={panelId}
              size="sm"
              onToggle={() => {
                setOpen(!open);
              }}
            />
          </div>
        </Td>
      </Tr>
      {open ? (
        <tr>
          <td colSpan={COLUMN_COUNT} className="px-6 pb-4">
            <RejectForm
              id={panelId}
              proposalId={proposalId}
              action={rejectAction}
              onCancel={() => {
                setOpen(false);
              }}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The same row at 360: a stacked card whose Reject opens the reason form inside it. */
export function ProposalCard({
  proposalId,
  accent,
  approveAction,
  rejectAction,
  snoozeAction,
  children,
}: {
  proposalId: string;
  accent?: RowAccent;
  approveAction: FormAction;
  rejectAction: FormAction;
  snoozeAction: FormAction | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = `reject-card-${proposalId}`;

  return (
    <div
      data-live-id={proposalId}
      className={cn(
        'flex flex-col gap-2 rounded-xl bg-card p-4',
        accent === undefined ? null : CARD_ACCENT[accent],
      )}
    >
      {children}
      <div className="flex items-center gap-2">
        <DecideActions
          proposalId={proposalId}
          size="lg"
          approveAction={approveAction}
          snoozeAction={snoozeAction}
        />
        <RejectButton
          open={open}
          panelId={panelId}
          size="lg"
          onToggle={() => {
            setOpen(!open);
          }}
        />
      </div>
      {open ? (
        <RejectForm
          id={panelId}
          proposalId={proposalId}
          action={rejectAction}
          onCancel={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
