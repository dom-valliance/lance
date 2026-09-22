import type { ReactNode } from 'react';
import { cn } from 'cn';
import { ExternalLink } from 'lucide-react';
import { ActionForm } from '@/components/action-form';
import { Ageing } from '@/components/ageing';
import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { SubmitButton } from '@/components/submit-button';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { dueLabel } from '@/lib/ageing';
import { humanise } from '@/lib/humanise';
import { assigneeText, sourceBadgeLabel, sourceStatusLine, type TaskView } from '@/lib/task-view';
import { formatDate } from '@/lib/time';
import { SYSTEM_TONES } from '@/lib/tones';
import { completeTask } from './actions';

/**
 * One page of tasks: the table on a desktop and the same rows as cards on a
 * phone. The page fetches, filters and matches pending proposals; this
 * renders.
 */

/** The seven columns, in order; `loading.tsx` keeps its own copy of the names. */
const TASK_COLUMNS = ['Title', 'Source', 'Due', 'Assignee', 'Meeting', 'Link', 'Complete'];

/**
 * What the Complete column offers for one row: the proposal that is
 * already pending for the task, the Notion Mark done form, or the sentence
 * that says Jamie is the only place a Jamie task closes (ADR 0005).
 */
function CompleteControl({
  task,
  proposalId,
  size,
}: {
  task: TaskView;
  proposalId: string | undefined;
  size: 'sm' | 'lg';
}) {
  if (proposalId !== undefined) {
    return (
      <TextLink
        href={`/proposals/${proposalId}`}
        className={cn('inline-flex items-center gap-2', size === 'lg' && 'min-h-11')}
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
        Proposal pending
      </TextLink>
    );
  }

  if (task.source === 'jamie') {
    return (
      <span
        className={cn(
          'inline-flex items-center text-xs text-muted-foreground',
          size === 'lg' && 'min-h-11',
        )}
      >
        Complete in Jamie
      </span>
    );
  }

  return (
    <ActionForm action={completeTask} className={cn(size === 'lg' && 'flex-1')}>
      <input type="hidden" name="source" value={task.source} />
      <input type="hidden" name="sourceId" value={task.sourceId} />
      <SubmitButton
        variant="outline"
        size={size}
        pendingLabel="Marking"
        className={cn(size === 'lg' && 'w-full')}
      >
        Mark done
      </SubmitButton>
    </ActionForm>
  );
}

/** "Open in Notion", "Open in Jamie", or the plain words when the source gave no link. */
function OpenLink({ task }: { task: TaskView }) {
  if (task.url === null) return <span className="text-xs text-muted-foreground">no link</span>;
  return (
    <TextLink href={task.url} className="inline-flex items-center gap-1">
      Open in {sourceBadgeLabel(task.source)}
      <ExternalLink aria-hidden className="size-3" />
    </TextLink>
  );
}

export function TasksTable({
  tasks,
  pending,
  now,
  footer,
}: {
  tasks: readonly TaskView[];
  /** Task id to the id of the complete-task proposal already waiting for it. */
  pending: ReadonlyMap<string, string>;
  now: Date;
  /** The paging footer, rendered under the table and under the cards. */
  footer: ReactNode;
}) {
  return (
    <>
      <TableCard className="hidden lg:block">
        <Table caption="Tasks across Notion and Jamie">
          <thead>
            <tr>
              {TASK_COLUMNS.map((column) => (
                <Th key={column}>{column}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const due = dueLabel(task.due, now);
              return (
                <Tr key={task.id} muted={task.done}>
                  <Td>
                    <p className="font-medium">{task.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{sourceStatusLine(task)}</p>
                  </Td>
                  <Td>
                    <Badge tone={SYSTEM_TONES[task.source]}>{sourceBadgeLabel(task.source)}</Badge>
                  </Td>
                  <Td>
                    {task.due === null ? (
                      <span className="text-muted-foreground">No date</span>
                    ) : (
                      formatDate(task.due)
                    )}
                    <Ageing className="mt-1 flex" label={due.label} emphasis={due.emphasis} />
                  </Td>
                  <Td>{assigneeText(task)}</Td>
                  <Td>
                    {task.meetingTitle === null ? (
                      <span className="text-muted-foreground">none</span>
                    ) : task.url === null ? (
                      task.meetingTitle
                    ) : (
                      <TextLink href={task.url} tone="foreground">
                        {task.meetingTitle}
                      </TextLink>
                    )}
                  </Td>
                  <Td>
                    <OpenLink task={task} />
                  </Td>
                  <Td>
                    <CompleteControl task={task} proposalId={pending.get(task.id)} size="sm" />
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
        {footer}
      </TableCard>

      <ul className="flex flex-col gap-3 lg:hidden">
        {tasks.map((task) => {
          const due = dueLabel(task.due, now);
          return (
            <li key={task.id} className="flex flex-col gap-3 rounded-xl bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <p className={cn('font-medium', task.done && 'text-muted-foreground')}>
                  {task.title}
                </p>
                <Badge tone={SYSTEM_TONES[task.source]}>{sourceBadgeLabel(task.source)}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {humanise(task.status)} · {assigneeText(task)} ·{' '}
                {task.due === null ? (
                  'no date'
                ) : (
                  <>
                    {formatDate(task.due)}, <Ageing label={due.label} emphasis={due.emphasis} />
                  </>
                )}
              </p>
              <div className="flex items-center gap-2">
                <CompleteControl task={task} proposalId={pending.get(task.id)} size="lg" />
                {task.url === null ? null : (
                  <Button asChild variant="outline" size="lg">
                    <a href={task.url} rel="noreferrer">
                      Open in {sourceBadgeLabel(task.source)}
                      <ExternalLink aria-hidden className="size-3.5" />
                    </a>
                  </Button>
                )}
              </div>
            </li>
          );
        })}
        <li className="overflow-hidden rounded-xl bg-card [&>div]:border-t-0">{footer}</li>
      </ul>
    </>
  );
}
