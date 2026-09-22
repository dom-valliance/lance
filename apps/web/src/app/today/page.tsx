import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import {
  asAfternoonBoard,
  asMorningBrief,
  generatedLabel,
  isBeforeBriefTime,
  isBoardTime,
  isTodaysBrief,
} from '@/lib/brief-view';
import { formatDayTitle, formatTime } from '@/lib/time';
import { apiClient } from '@/lib/trpc';
import { AfternoonBoardSection } from './afternoon-board';
import { AgentHealthSection } from './agent-health';
import { DayShapeSection } from './day-shape';
import { MeetingsSection } from './meetings';
import { OvernightSection } from './overnight';
import { TasksSection } from './tasks';
import { WaitingForSection } from './waiting-for';

export const dynamic = 'force-dynamic';

/**
 * Dom's first screen of the day (spec 10.1 and 10.2, design 7.1). The page
 * reads both briefs the planner writes and renders whichever belong to
 * today: the morning brief in six sections, and the afternoon board
 * beneath it from 16:00. `now` is taken once so every relative label on
 * the page describes the same instant.
 */
export default async function TodayPage() {
  const now = new Date();
  const client = await apiClient();
  const [morningRecord, boardRecord] = await Promise.all([
    client.briefs.latest.query({ kind: 'morning_brief' }),
    client.briefs.latest.query({ kind: 'afternoon_board' }),
  ]);

  const brief = isTodaysBrief(morningRecord, now) ? asMorningBrief(morningRecord) : null;
  const board =
    isBoardTime(now) && isTodaysBrief(boardRecord, now) ? asAfternoonBoard(boardRecord) : null;

  const summary =
    brief !== null
      ? brief.content.headline
      : isBeforeBriefTime(now)
        ? formatTime(now)
        : 'No brief yet today.';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={formatDayTitle(now)}
        summary={summary}
        actions={
          brief === null ? null : (
            <span className="text-xs text-muted-foreground">
              {generatedLabel(brief.generatedAt, now)}
            </span>
          )
        }
      />

      {/*
       * There is no `briefs.regenerate` mutation yet, so the page cannot
       * offer a working button for it. A web regenerate control arrives
       * with the Settings page's controls (spec 12, Settings row); until
       * then this sentence is the whole story, on both the empty state
       * below and once a brief has rendered.
       */}
      <p className="text-xs text-muted-foreground">
        Regenerate this brief with <span className="font-mono">/lance brief</span> in Slack.
      </p>

      {brief === null ? (
        <section className="rounded-xl bg-card p-6">
          <p className="text-sm text-muted-foreground">
            {isBeforeBriefTime(now)
              ? 'No brief has been generated yet today. The morning brief is due at 06:30 on weekdays.'
              : 'No brief was generated today. The next morning brief is due at 06:30 on weekdays.'}
          </p>
        </section>
      ) : (
        <>
          <DayShapeSection
            shape={brief.content.dayShape}
            meetings={brief.content.meetings}
            now={now}
          />
          <MeetingsSection meetings={brief.content.meetings} now={now} />
          <div className="grid gap-6 lg:grid-cols-2">
            <TasksSection tasks={brief.content.tasks} />
            <WaitingForSection waitingFor={brief.content.waitingFor} />
          </div>
          <OvernightSection overnight={brief.content.overnight} />
          <AgentHealthSection health={brief.content.agentHealth} />
        </>
      )}

      {board === null ? null : <AfternoonBoardSection board={board.content} now={now} />}

      <LiveRefresh streamUrl="/api/events" watch="proposal" />
    </div>
  );
}
