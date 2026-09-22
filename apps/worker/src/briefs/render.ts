import type { AfternoonBoardContent, MorningBriefContent } from '@lance/shared';

/**
 * Plain text renderings of a brief for Slack (a parent message and one
 * reply per section, spec 9.1) and markdown for `briefs.markdown`. The
 * Today page renders the structured content itself. Provenance links
 * appear as `<url|source>` in Slack and as markdown links where a url
 * exists.
 */

function time(iso: string | null | undefined, timeZone: string): string {
  if (iso === null || iso === undefined) return 'none';
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

function slackLink(url: string | undefined | null, label: string): string {
  return url === undefined || url === null ? label : `<${url}|${label}>`;
}

function mdLink(url: string | undefined | null, label: string): string {
  return url === undefined || url === null ? label : `[${label}](${url})`;
}

function attendeeLine(
  meeting: MorningBriefContent['meetings'][number],
  unknownMark: string,
): string {
  return (
    meeting.attendees
      .map(
        (a) =>
          `${a.name}${a.organisation === null ? '' : `, ${a.organisation}`}${a.unknown ? unknownMark : ''}`,
      )
      .join('; ') || 'none'
  );
}

function recent(meeting: MorningBriefContent['meetings'][number]) {
  return meeting.attendees
    .flatMap((a) => a.interactions.map((i) => ({ ...i, who: a.name })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 3);
}

function taskLine(
  t: MorningBriefContent['tasks']['items'][number],
  i: number,
  link: (url: string | null, label: string) => string,
): string {
  return `${String(i + 1)}. ${link(t.url, t.title)} (${t.source}${t.overdueDays === null ? '' : `, ${String(t.overdueDays)} days overdue`})${t.reason === '' ? '' : `: ${t.reason}`}`;
}

function healthLine(health: MorningBriefContent['agentHealth']): string {
  const watchers =
    health.watchers
      .map(
        (w) =>
          `${w.name} ${String(w.ageMinutes)} min${w.state === 'healthy' ? '' : ` (${w.state})`}`,
      )
      .join(', ') || 'no watchers have run';
  return `Watchers: ${watchers}. Breakers open: ${String(health.breakersOpen)}. Cost yesterday £${health.costYesterdayGbp.toFixed(2)}, today £${health.costTodayGbp.toFixed(2)} of £${health.ceilingGbp.toFixed(2)}.`;
}

export interface SlackBrief {
  parent: string;
  sections: { key: string; text: string }[];
}

export function renderMorningBriefSlack(
  brief: MorningBriefContent,
  timeZone: string,
  displayName: string,
): SlackBrief {
  const shape = brief.dayShape;
  const parent = [
    `*${displayName} morning brief, ${brief.date}*`,
    brief.headline,
    `First meeting ${time(shape.firstMeeting?.start, timeZone)}, last ${time(shape.lastMeeting?.start, timeZone)}, ${String(shape.meetingHours)} h in meetings, longest free block ${shape.longestFreeBlock === null ? 'none' : `${String(shape.longestFreeBlock.hours)} h`}${shape.proposedHolds.length === 0 ? '' : ` (${String(shape.proposedHolds.length)} holds proposed)`}.`,
    `${String(brief.tasks.total)} tasks due, ${String(brief.waitingFor.length)} waiting for, ${String(brief.overnight.awaiting.count)} proposals pending.`,
  ].join('\n');

  const sections: SlackBrief['sections'] = [];
  for (const meeting of brief.meetings) {
    const lines = [
      `*${time(meeting.start, timeZone)} ${meeting.title}*${meeting.audience === 'external' ? ' (external)' : ''} ${slackLink(meeting.provenance.url, 'calendar')}`,
      `Attendees: ${attendeeLine(meeting, ' [unknown]')}`,
      ...(meeting.objectives.length === 0 ? [] : [`Objectives: ${meeting.objectives.join(' ')}`]),
      ...(meeting.commitments.length === 0
        ? []
        : [
            `Open: ${meeting.commitments.map((c) => `${c.direction === 'outbound' ? 'you owe' : 'owed to you'} ${c.description}`).join('; ')}`,
          ]),
      ...(recent(meeting).length === 0
        ? []
        : [
            `Recent: ${recent(meeting)
              .map((i) => `${i.at.slice(0, 10)} ${slackLink(i.provenance.url, i.summary)}`)
              .join('; ')}`,
          ]),
      ...(meeting.documents.length === 0
        ? []
        : [`Documents: ${meeting.documents.map((d) => slackLink(d.url, d.title)).join('; ')}`]),
    ];
    sections.push({ key: `meeting:${meeting.id}`, text: lines.join('\n') });
  }
  sections.push({
    key: 'tasks',
    text: `*Tasks*\n${
      brief.tasks.items
        .slice(0, 5)
        .map((t, i) => taskLine(t, i, slackLink))
        .join('\n') || 'none due'
    }`,
  });
  sections.push({
    key: 'waiting',
    text: `*Waiting for*\n${brief.waitingFor.map((c) => `${c.counterparty}: ${c.description}${c.overdueDays === null ? '' : ` (${String(c.overdueDays)} days overdue)`}. ${c.pendingChaseProposalId === null ? `Chase with /lance chase ${c.commitmentId}` : 'Chase proposal pending'}`).join('\n') || 'nothing overdue'}`,
  });
  sections.push({
    key: 'overnight',
    text: [
      '*Overnight*',
      `Alerts: ${brief.overnight.alerts.map((a) => `${a.severity} ${a.title}`).join('; ') || 'none'}`,
      `Pending proposals: ${String(brief.overnight.awaiting.count)}${brief.overnight.awaiting.top.length === 0 ? '' : ` (${brief.overnight.awaiting.top.map((p) => p.preview).join('; ')})`}`,
      `Executed automatically: ${brief.overnight.executed.map((p) => p.summary).join('; ') || 'none'}`,
    ].join('\n'),
  });
  sections.push({ key: 'health', text: `*Agent health*\n${healthLine(brief.agentHealth)}` });
  return { parent, sections };
}

export function renderMorningBriefMarkdown(brief: MorningBriefContent, timeZone: string): string {
  const out: string[] = [`# Morning brief, ${brief.date}`, '', brief.headline, ''];
  const s = brief.dayShape;
  out.push(
    `First meeting ${time(s.firstMeeting?.start, timeZone)}, last ${time(s.lastMeeting?.start, timeZone)}, ${String(s.meetingHours)} hours in meetings, longest free block ${s.longestFreeBlock === null ? 'none' : `${String(s.longestFreeBlock.hours)} hours`}.`,
    ...(s.note === null ? [] : [s.note]),
    '',
  );
  out.push('## Meetings');
  for (const m of brief.meetings) {
    out.push(
      `### ${time(m.start, timeZone)} ${mdLink(m.provenance.url, m.title)}${m.audience === 'external' ? ' (external)' : ''}`,
    );
    out.push(`Attendees: ${attendeeLine(m, ' (unknown)')}`);
    if (m.objectives.length > 0) out.push(`Objectives: ${m.objectives.join(' ')}`);
    for (const c of m.commitments)
      out.push(`- ${c.direction === 'outbound' ? 'You owe' : 'Owed to you'}: ${c.description}`);
    for (const i of recent(m))
      out.push(`- ${i.at.slice(0, 10)} ${mdLink(i.provenance.url, i.summary)}`);
    for (const d of m.documents) out.push(`- ${mdLink(d.url, d.title)}`);
    out.push('');
  }
  if (brief.meetings.length === 0) out.push('None.', '');
  out.push('## Tasks');
  out.push(
    ...brief.tasks.items.slice(0, 5).map((t, i) => taskLine(t, i, mdLink)),
    brief.tasks.items.length === 0 ? 'None due.' : '',
    '',
  );
  out.push('## Waiting for');
  out.push(
    ...brief.waitingFor.map(
      (c) =>
        `- ${c.counterparty}: ${c.description}${c.overdueDays === null ? '' : ` (${String(c.overdueDays)} days overdue)`}`,
    ),
    brief.waitingFor.length === 0 ? 'Nothing overdue.' : '',
    '',
  );
  out.push('## Overnight');
  out.push(
    `Alerts: ${brief.overnight.alerts.map((a) => `${a.severity} ${a.title}`).join('; ') || 'none'}`,
  );
  out.push(`Pending proposals: ${String(brief.overnight.awaiting.count)}`);
  out.push(
    `Executed automatically: ${brief.overnight.executed.map((p) => p.summary).join('; ') || 'none'}`,
    '',
  );
  out.push('## Agent health', healthLine(brief.agentHealth));
  return out.join('\n');
}

function decidedLine(d: AfternoonBoardContent['moved']['proposalsDecided']): string {
  return `${String(d.approved)} approved, ${String(d.edited)} edited, ${String(d.rejected)} rejected`;
}

function tomorrowLine(board: AfternoonBoardContent, timeZone: string): string {
  const m = board.tomorrowFirstMeeting;
  if (m === null) return 'Tomorrow: no meetings.';
  return `Tomorrow first: ${time(m.start, timeZone)} ${m.title}${m.audience === 'external' ? ' (external)' : ''}, prep ${m.prepExists ? 'ready' : 'not yet written'}.`;
}

export function renderAfternoonBoardSlack(
  board: AfternoonBoardContent,
  timeZone: string,
  displayName: string,
  date: string,
): string {
  return [
    `*${displayName} afternoon board, ${date}*`,
    `Tasks completed: ${board.moved.tasksCompleted.map((t) => t.title).join('; ') || 'none'}`,
    `Proposals decided: ${decidedLine(board.moved.proposalsDecided)}`,
    `Commitments closed: ${board.moved.commitmentsClosed.map((c) => c.description).join('; ') || 'none'}`,
    `Still pending your decision: ${String(board.pending.length)}${
      board.pending.length === 0
        ? ''
        : ` (${board.pending
            .slice(0, 3)
            .map((p) => p.preview)
            .join('; ')})`
    }`,
    tomorrowLine(board, timeZone),
  ].join('\n');
}

export function renderAfternoonBoardMarkdown(
  board: AfternoonBoardContent,
  timeZone: string,
  date: string,
): string {
  return [
    `# Afternoon board, ${date}`,
    '',
    `Since ${board.since}.`,
    '',
    '## Tasks completed',
    ...board.moved.tasksCompleted.map((t) => `- ${mdLink(t.url, t.title)}`),
    board.moved.tasksCompleted.length === 0 ? 'None.' : '',
    '## Proposals decided',
    decidedLine(board.moved.proposalsDecided),
    '## Commitments closed',
    ...board.moved.commitmentsClosed.map((c) => `- ${c.description}`),
    board.moved.commitmentsClosed.length === 0 ? 'None.' : '',
    '## Pending decision',
    ...board.pending.map((p) => `- ${p.preview}`),
    board.pending.length === 0 ? 'None.' : '',
    '## Tomorrow',
    tomorrowLine(board, timeZone),
  ].join('\n');
}
