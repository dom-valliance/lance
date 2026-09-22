import type { AfternoonBoard, MorningBrief } from './schema.js';

/**
 * Plain text renderings of a brief for Slack (a parent message and one
 * reply per section, spec 9.1) and markdown for `briefs.markdown` and the
 * Today page. Provenance links appear as `<url|source>` in Slack and as
 * markdown links on the page where a url exists.
 */

function time(iso: string | null, timeZone: string): string {
  if (iso === null) return 'none';
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

function slackLink(url: string | undefined, label: string): string {
  return url === undefined ? label : `<${url}|${label}>`;
}

export interface SlackBrief {
  parent: string;
  sections: { key: string; text: string }[];
}

export function renderMorningBriefSlack(
  brief: MorningBrief,
  timeZone: string,
  displayName: string,
): SlackBrief {
  const shape = brief.dayShape;
  const parent = [
    `*${displayName} morning brief, ${brief.date}*`,
    `First meeting ${time(shape.firstMeeting, timeZone)}, last ${time(shape.lastMeeting, timeZone)}, ${String(shape.meetingHours)} h in meetings, longest free block ${String(shape.longestFreeBlockHours)} h${shape.freeTimeShort ? ' (short; holds proposed)' : ''}.`,
    `${String(brief.meetings.length)} meetings, ${String(brief.tasks.length)} tasks due, ${String(brief.waitingFor.length)} waiting for, ${String(brief.overnight.pendingProposals.count)} proposals pending.`,
  ].join('\n');

  const sections: SlackBrief['sections'] = [];
  for (const meeting of brief.meetings) {
    const lines = [
      `*${time(meeting.start, timeZone)} ${meeting.subject}*${meeting.isExternal ? ' (external)' : ''} ${slackLink(meeting.provenance[0]?.url, 'calendar')}`,
      `Attendees: ${meeting.attendees.map((a) => `${a.name}${a.organisation === null ? '' : `, ${a.organisation}`}${a.known ? '' : ' [unknown]'}`).join('; ') || 'none'}`,
      ...(meeting.objectives.length === 0 ? [] : [`Objectives: ${meeting.objectives.join(' ')}`]),
      ...(meeting.openCommitments.length === 0
        ? []
        : [
            `Open: ${meeting.openCommitments.map((c) => `${c.direction === 'outbound' ? 'you owe' : 'owed to you'} ${c.description}`).join('; ')}`,
          ]),
      ...(meeting.lastInteractions.length === 0
        ? []
        : [
            `Recent: ${meeting.lastInteractions
              .slice(0, 3)
              .map((i) => `${i.at.slice(0, 10)} ${slackLink(i.provenance[0]?.url, i.summary)}`)
              .join('; ')}`,
          ]),
      ...(meeting.documents.length === 0
        ? []
        : [
            `Documents: ${meeting.documents.map((d) => slackLink(d.url ?? undefined, d.title)).join('; ')}`,
          ]),
    ];
    sections.push({ key: `meeting:${meeting.eventId}`, text: lines.join('\n') });
  }
  sections.push({
    key: 'tasks',
    text: `*Tasks*\n${
      brief.tasks
        .slice(0, 5)
        .map(
          (t, i) =>
            `${String(i + 1)}. ${slackLink(t.url ?? undefined, t.title)} (${t.source}${t.overdue ? ', overdue' : ''})${t.reason === null ? '' : `: ${t.reason}`}`,
        )
        .join('\n') || 'none due'
    }`,
  });
  sections.push({
    key: 'waiting',
    text: `*Waiting for*\n${brief.waitingFor.map((c) => `${c.counterparty}: ${c.description}${c.daysOverdue === null ? '' : ` (${String(c.daysOverdue)} days overdue)`}. Chase with /lance chase ${c.id}`).join('\n') || 'nothing overdue'}`,
  });
  sections.push({
    key: 'overnight',
    text: [
      '*Overnight*',
      `Alerts: ${brief.overnight.alerts.map((a) => `${a.severity} ${a.title}`).join('; ') || 'none'}`,
      `Pending proposals: ${String(brief.overnight.pendingProposals.count)}${brief.overnight.pendingProposals.top.length === 0 ? '' : ` (${brief.overnight.pendingProposals.top.map((p) => p.preview).join('; ')})`}`,
      `Executed automatically: ${brief.overnight.executedAuto.map((p) => p.preview).join('; ') || 'none'}`,
    ].join('\n'),
  });
  sections.push({ key: 'health', text: `*Agent health*\n${brief.agentHealth.line}` });
  return { parent, sections };
}

export function renderMorningBriefMarkdown(brief: MorningBrief, timeZone: string): string {
  const link = (url: string | undefined | null, label: string): string =>
    url ? `[${label}](${url})` : label;
  const out: string[] = [`# Morning brief, ${brief.date}`, ''];
  const s = brief.dayShape;
  out.push(
    `First meeting ${time(s.firstMeeting, timeZone)}, last ${time(s.lastMeeting, timeZone)}, ${String(s.meetingHours)} hours in meetings, longest free block ${String(s.longestFreeBlockHours)} hours.`,
    '',
  );
  out.push('## Meetings');
  for (const m of brief.meetings) {
    out.push(
      `### ${time(m.start, timeZone)} ${link(m.provenance[0]?.url, m.subject)}${m.isExternal ? ' (external)' : ''}`,
    );
    out.push(
      `Attendees: ${m.attendees.map((a) => `${a.name}${a.organisation === null ? '' : `, ${a.organisation}`}${a.known ? '' : ' (unknown)'}`).join('; ') || 'none'}`,
    );
    if (m.objectives.length > 0) out.push(`Objectives: ${m.objectives.join(' ')}`);
    for (const c of m.openCommitments)
      out.push(`- ${c.direction === 'outbound' ? 'You owe' : 'Owed to you'}: ${c.description}`);
    for (const i of m.lastInteractions.slice(0, 3))
      out.push(`- ${i.at.slice(0, 10)} ${link(i.provenance[0]?.url, i.summary)}`);
    for (const d of m.documents) out.push(`- ${link(d.url, d.title)}`);
    out.push('');
  }
  if (brief.meetings.length === 0) out.push('None.', '');
  out.push('## Tasks');
  out.push(
    ...brief.tasks
      .slice(0, 5)
      .map(
        (t, i) =>
          `${String(i + 1)}. ${link(t.url, t.title)} (${t.source}${t.overdue ? ', overdue' : ''})${t.reason === null ? '' : `: ${t.reason}`}`,
      ),
    brief.tasks.length === 0 ? 'None due.' : '',
    '',
  );
  out.push('## Waiting for');
  out.push(
    ...brief.waitingFor.map(
      (c) =>
        `- ${c.counterparty}: ${c.description}${c.daysOverdue === null ? '' : ` (${String(c.daysOverdue)} days overdue)`}`,
    ),
    brief.waitingFor.length === 0 ? 'Nothing overdue.' : '',
    '',
  );
  out.push('## Overnight');
  out.push(
    `Alerts: ${brief.overnight.alerts.map((a) => `${a.severity} ${a.title}`).join('; ') || 'none'}`,
  );
  out.push(`Pending proposals: ${String(brief.overnight.pendingProposals.count)}`);
  out.push(
    `Executed automatically: ${brief.overnight.executedAuto.map((p) => p.preview).join('; ') || 'none'}`,
    '',
  );
  out.push('## Agent health', brief.agentHealth.line);
  return out.join('\n');
}

export function renderAfternoonBoardSlack(
  board: AfternoonBoard,
  timeZone: string,
  displayName: string,
): string {
  return [
    `*${displayName} afternoon board, ${board.date}*`,
    `Tasks completed: ${board.tasksCompleted.map((t) => t.title).join('; ') || 'none'}`,
    `Proposals decided: ${board.proposalsDecided.map((p) => `${p.preview} (${p.status})`).join('; ') || 'none'}`,
    `Commitments closed: ${board.commitmentsClosed.map((c) => c.description).join('; ') || 'none'}`,
    `Still pending your decision: ${String(board.pendingDecision.length)}${
      board.pendingDecision.length === 0
        ? ''
        : ` (${board.pendingDecision
            .slice(0, 3)
            .map((p) => p.preview)
            .join('; ')})`
    }`,
    board.tomorrowFirstMeeting === null
      ? 'Tomorrow: no meetings.'
      : `Tomorrow first: ${time(board.tomorrowFirstMeeting.start, timeZone)} ${board.tomorrowFirstMeeting.subject}, prep ${board.tomorrowFirstMeeting.prepExists ? 'ready' : 'not yet written'}.`,
  ].join('\n');
}

export function renderAfternoonBoardMarkdown(board: AfternoonBoard, timeZone: string): string {
  return [
    `# Afternoon board, ${board.date}`,
    '',
    `Since ${board.since}.`,
    '',
    '## Tasks completed',
    ...board.tasksCompleted.map((t) => `- ${t.title} (${t.source})`),
    board.tasksCompleted.length === 0 ? 'None.' : '',
    '## Proposals decided',
    ...board.proposalsDecided.map((p) => `- ${p.preview}: ${p.status}`),
    board.proposalsDecided.length === 0 ? 'None.' : '',
    '## Commitments closed',
    ...board.commitmentsClosed.map((c) => `- ${c.description}`),
    board.commitmentsClosed.length === 0 ? 'None.' : '',
    '## Pending decision',
    ...board.pendingDecision.map((p) => `- ${p.preview}`),
    board.pendingDecision.length === 0 ? 'None.' : '',
    '## Tomorrow',
    board.tomorrowFirstMeeting === null
      ? 'No meetings.'
      : `${time(board.tomorrowFirstMeeting.start, timeZone)} ${board.tomorrowFirstMeeting.subject}. Prep ${board.tomorrowFirstMeeting.prepExists ? 'ready' : 'not yet written'}.`,
  ].join('\n');
}
