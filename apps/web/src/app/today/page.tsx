import { LiveRefresh } from '@/components/live-refresh';
import {
  asAfternoonBoard,
  asMorningBrief,
  generatedLabel,
  isBeforeBriefTime,
  isBoardTime,
  isTodaysBrief,
  noBriefSummary,
} from '@/lib/brief-view';
import { formatDayTitle, formatTime } from '@/lib/time';
import { apiClient } from '@/lib/trpc';
import { AfternoonBoardSection } from './afternoon-board';
import { AgentHealthSection } from './agent-health';
import { DayShapeSection } from './day-shape';
import { MeetingsSection } from './meetings';
import { OvernightSection } from './overnight';
import { TasksSection } from './tasks';
import { TodayHeader } from './today-header';
import { WaitingForSection } from './waiting-for';

export const dynamic = 'force-dynamic';

/**
 * Dom's first screen of the day (spec 10.1 and 10.2, design 7.1). The page
 * reads both briefs the planner writes and renders whichever belong to
 * today: the morning brief in six sections, and the afternoon board
 * beneath it from 16:00. When today has no brief yet, the newest morning
 * brief of any day gives the summary its "last successful" line. `now` is
 * taken once so every relative label on the page describes the same
 * instant.
 */
export default async function TodayPage() {
  const now = new Date();
  const client = await apiClient();
  const [morningRecord, boardRecord, history] = await Promise.all([
    client.briefs.latest.query({ kind: 'morning_brief' }),
    client.briefs.latest.query({ kind: 'afternoon_board' }),
    client.briefs.list.query({ kind: 'morning_brief', limit: 1 }),
  ]);

  const brief = isTodaysBrief(morningRecord, now) ? asMorningBrief(morningRecord) : null;
  const board =
    isBoardTime(now) && isTodaysBrief(boardRecord, now) ? asAfternoonBoard(boardRecord) : null;
  const lastGeneratedAt = history.items[0]?.generatedAt ?? null;

  const summary =
    brief !== null
      ? brief.content.headline
      : isBeforeBriefTime(now)
        ? formatTime(now)
        : noBriefSummary(lastGeneratedAt, now);

  return (
    <div className="flex flex-col gap-6">
      <TodayHeader
        title={formatDayTitle(now)}
        summary={summary}
        generatedAt={brief?.generatedAt ?? null}
        generatedLine={brief === null ? null : generatedLabel(brief.generatedAt, now)}
      />

      {brief === null ? (
        <section className="rounded-xl bg-card px-6 py-12">
          <p className="text-sm text-muted-foreground">
            {isBeforeBriefTime(now)
              ? "Today's brief arrives at 06:30. Regenerate to build it now."
              : 'No brief was generated today. Regenerate to build one now; the next scheduled brief is 06:30 on the next weekday.'}
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
