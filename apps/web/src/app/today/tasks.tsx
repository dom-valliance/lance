import { cn } from 'cn';
import { EmptyState } from '@/components/empty-state';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { tasksFooter, type BriefTask } from '@/lib/brief-view';
import { SYSTEM_LABELS } from '@/lib/humanise';
import { SYSTEM_TONES } from '@/lib/tones';

/** The brief ranks five; the phone layout shows three and links to the rest. */
const PHONE_ROWS = 3;

/**
 * Spec 10.1 item 3: the planner's top five tasks due today or overdue,
 * deduplicated across Notion and Jamie, each with its one-line reason.
 */
export function TasksSection({
  tasks,
}: {
  tasks: { items: BriefTask[]; total: number; duplicatesMerged: number };
}) {
  const items = tasks.items.slice(0, 5);
  const hiddenOnPhone = Math.max(tasks.total - PHONE_ROWS, 0);
  return (
    <section className="flex flex-col gap-4 rounded-xl bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Tasks due today or overdue</h2>
        <TextLink href="/tasks" className="text-xs">
          All tasks
        </TextLink>
      </div>

      {items.length === 0 ? (
        <EmptyState className="px-0 py-6">
          Nothing is due today. <TextLink href="/tasks">Open the task list</TextLink> to see what is
          ahead.
        </EmptyState>
      ) : (
        <ol className="flex flex-col">
          {items.map((task, index) => (
            <li
              key={task.taskId}
              className={cn(
                'grid grid-cols-[20px_1fr_auto] items-start gap-3 border-t border-border py-3 first:border-t-0 first:pt-0',
                index >= PHONE_ROWS && 'hidden lg:grid',
              )}
            >
              <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <div className="min-w-0">
                <TextLink href={task.url ?? '/tasks'} tone="foreground" className="text-sm">
                  {task.title}
                </TextLink>
                <p className="mt-0.5 text-xs text-muted-foreground">{task.reason}</p>
              </div>
              <Badge tone={SYSTEM_TONES[task.source]} size="sm">
                {SYSTEM_LABELS[task.source]}
              </Badge>
            </li>
          ))}
        </ol>
      )}

      {hiddenOnPhone === 0 ? null : (
        <p className="text-xs lg:hidden">
          <TextLink href="/tasks" className="inline-flex min-h-11 items-center">
            {hiddenOnPhone} more
          </TextLink>
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        {tasksFooter(tasks.total, tasks.duplicatesMerged)}
      </p>
    </section>
  );
}
