'use client';

import { useState, type ReactNode } from 'react';
import { cn } from 'cn';
import { ActionForm, type FormAction } from '@/components/action-form';
import { Td, Tr, type RowAccent } from '@/components/data-table';
import { SubmitButton } from '@/components/submit-button';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * Drop asks for a reason, and the reason field was crowding the actions
 * cell (design brief 7.5). It is an inline expansion instead: the Drop
 * button carries `aria-expanded` and points at a panel that opens beneath
 * the row. The toggle state has to reach a sibling table row, so the row
 * pair is one client component; the phone card is the same disclosure in
 * the stacked layout.
 */

/** The six columns of the Commitments table the expansion spans. */
const COLUMN_COUNT = 6;

function DropForm({
  id,
  commitmentId,
  counterpartyFirstName,
  action,
  onCancel,
}: {
  id: string;
  commitmentId: string;
  counterpartyFirstName: string;
  action: FormAction;
  onCancel: () => void;
}) {
  return (
    <div id={id} className="flex flex-col gap-3 rounded-lg bg-muted/50 p-4">
      <ActionForm action={action} className="flex flex-col gap-3">
        <input type="hidden" name="commitmentId" value={commitmentId} />
        <Field label="Reason for dropping, required" className="max-w-md">
          <Input name="reason" required autoFocus placeholder="Why this no longer needs chasing" />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton variant="destructive" size="sm" pendingLabel="Dropping">
            Drop this commitment
          </SubmitButton>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Dropping is recorded in the ledger with your reason. Nothing is sent to{' '}
          {counterpartyFirstName}.
        </p>
      </ActionForm>
    </div>
  );
}

function DropButton({
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
      Drop
    </Button>
  );
}

/**
 * One open or chased row and the expansion under it. `children` is the
 * row's leading cells, rendered on the server; `actions` is the Mark done
 * and Chase forms that share the actions cell with Drop.
 */
export function CommitmentRowPair({
  commitmentId,
  counterpartyFirstName,
  dropAction,
  accent,
  actions,
  children,
}: {
  commitmentId: string;
  counterpartyFirstName: string;
  dropAction: FormAction;
  accent?: RowAccent;
  actions: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = `drop-${commitmentId}`;
  const accentProp = accent === undefined ? {} : { accent };

  return (
    <>
      <Tr {...accentProp}>
        {children}
        <Td>
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            <DropButton
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
            <DropForm
              id={panelId}
              commitmentId={commitmentId}
              counterpartyFirstName={counterpartyFirstName}
              action={dropAction}
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

/** The same row at 360: a stacked card whose Drop opens the reason form inside it. */
export function CommitmentCard({
  commitmentId,
  counterpartyFirstName,
  dropAction,
  overdue,
  actions,
  children,
}: {
  commitmentId: string;
  counterpartyFirstName: string;
  dropAction: FormAction;
  overdue: boolean;
  actions: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = `drop-card-${commitmentId}`;

  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-xl bg-card p-4',
        overdue && 'shadow-[inset_2px_0_0_var(--sem-red-fg)]',
      )}
    >
      {children}
      <div className="flex items-center gap-2">
        {actions}
        <DropButton
          open={open}
          panelId={panelId}
          size="lg"
          onToggle={() => {
            setOpen(!open);
          }}
        />
      </div>
      {open ? (
        <DropForm
          id={panelId}
          commitmentId={commitmentId}
          counterpartyFirstName={counterpartyFirstName}
          action={dropAction}
          onCancel={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </li>
  );
}
