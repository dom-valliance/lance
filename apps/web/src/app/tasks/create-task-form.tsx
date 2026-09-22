'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ActionForm, type FormAction } from '@/components/action-form';
import { PageHeader } from '@/components/page-header';
import { SubmitButton } from '@/components/submit-button';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * The page header and the Create task form share one piece of state: the
 * button in the header's actions slot opens the card that sits under it,
 * so both live in this one client component. The form results in a
 * proposal, never in a task, which the sentence under the buttons says.
 */
export function TasksHeader({ summary, action }: { summary: string; action: FormAction }) {
  const [open, setOpen] = useState(false);
  const panelId = 'create-task';

  return (
    <>
      <PageHeader
        title="Tasks"
        summary={summary}
        actions={
          <Button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              setOpen(!open);
            }}
          >
            <Plus aria-hidden />
            Create task
          </Button>
        }
      />
      {open ? (
        <div id={panelId} className="rounded-xl bg-card p-4 lg:p-6">
          <ActionForm action={action} className="flex flex-col gap-4">
            <div className="grid gap-4 lg:grid-cols-4">
              <Field label="Title, required" className="lg:col-span-2">
                <Input name="title" required autoFocus placeholder="What needs doing" />
              </Field>
              <Field label="Due">
                <Input name="due" type="date" />
              </Field>
              <Field label="Project">
                <Select name="project" defaultValue="">
                  <option value="">No project</option>
                </Select>
              </Field>
              <Field label="Notes" className="lg:col-span-4">
                <Textarea name="notes" rows={2} placeholder="Anything the proposal should carry" />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <SubmitButton pendingLabel="Proposing">Propose this task</SubmitButton>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              <p className="text-xs text-muted-foreground">
                Creates a proposal, not a task. You approve it next.
              </p>
            </div>
          </ActionForm>
        </div>
      ) : null}
    </>
  );
}
