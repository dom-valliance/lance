'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  costChartLabelIndices,
  costChartPoints,
  costChartShowsCeiling,
  costChartYFor,
  type CostByDay,
} from '@/lib/agents-view';
import { formatDayMonth, formatGbp } from '@/lib/brief-view';

/**
 * The Cost by day card body: a table or a line graph of the same rows,
 * switched by a client-side toggle. The choice is remembered per browser
 * in localStorage, read after mount so the first frame matches the
 * server's (which always renders the Graph default) and hydration does
 * not mismatch.
 */

type View = 'table' | 'graph';

const VIEW_STORAGE_KEY = 'lance.agents.cost-by-day.view';
const DEFAULT_VIEW: View = 'graph';

const CHART_WIDTH = 560;
const CHART_HEIGHT = 220;
const CHART_PADDING = 36;

function isView(value: unknown): value is View {
  return value === 'table' || value === 'graph';
}

function readStoredView(): View | null {
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return isView(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredView(view: View): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage may be unavailable (private browsing, quota, disabled
    // storage); the choice simply does not persist for this visit.
  }
}

function ViewToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <div role="group" aria-label="Cost by day view" className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={view === 'table'}
        className="aria-pressed:bg-muted"
        onClick={() => {
          onChange('table');
        }}
      >
        Table
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={view === 'graph'}
        className="aria-pressed:bg-muted"
        onClick={() => {
          onChange('graph');
        }}
      >
        Graph
      </Button>
    </div>
  );
}

function CostTable({ days }: { days: CostByDay[] }) {
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Cost by day, most recent last</caption>
      <tbody>
        {days.map((day) => (
          <tr key={day.date} className="border-t border-border first:border-t-0">
            <td className="py-1.5 text-xs text-muted-foreground">{formatDayMonth(day.date)}</td>
            <td className="py-1.5 text-right">{formatGbp(day.gbp)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CostGraph({ days, ceilingGbp }: { days: CostByDay[]; ceilingGbp: number }) {
  const { points, maxGbp, top, bottom } = costChartPoints(
    days,
    CHART_WIDTH,
    CHART_HEIGHT,
    CHART_PADDING,
  );
  const labelIndices = costChartLabelIndices(days.length);
  const showCeiling = costChartShowsCeiling(ceilingGbp, maxGbp);
  const ceilingY = costChartYFor(ceilingGbp, maxGbp, top, bottom);
  const polylinePoints = points.map((point) => `${String(point.x)},${String(point.y)}`).join(' ');
  const first = days[0];
  const last = days[days.length - 1];
  const titleId = 'cost-by-day-graph-title';

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
        role="img"
        aria-labelledby={titleId}
        className="w-full"
      >
        <title id={titleId}>
          {first === undefined || last === undefined
            ? 'No cost recorded yet'
            : `Daily agent cost from ${formatDayMonth(first.date)} to ${formatDayMonth(last.date)}, up to ${formatGbp(maxGbp)} a day`}
        </title>

        <line
          x1={CHART_PADDING}
          y1={bottom}
          x2={CHART_WIDTH - CHART_PADDING}
          y2={bottom}
          className="stroke-border"
        />

        {showCeiling ? (
          <>
            <line
              x1={CHART_PADDING}
              y1={ceilingY}
              x2={CHART_WIDTH - CHART_PADDING}
              y2={ceilingY}
              strokeDasharray="4 4"
              className="stroke-sem-red-fg"
            />
            <text
              x={CHART_WIDTH - CHART_PADDING}
              y={ceilingY - 6}
              textAnchor="end"
              className="fill-sem-red-fg text-[10px]"
            >
              Ceiling {formatGbp(ceilingGbp)}
            </text>
          </>
        ) : null}

        <polyline
          points={polylinePoints}
          fill="none"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="stroke-brand"
        />
        {points.map((point) => (
          <circle key={point.date} cx={point.x} cy={point.y} r={3} className="fill-brand" />
        ))}

        <text
          x={4}
          y={bottom}
          dominantBaseline="middle"
          className="fill-muted-foreground text-[10px]"
        >
          {formatGbp(0)}
        </text>
        <text x={4} y={top} dominantBaseline="middle" className="fill-muted-foreground text-[10px]">
          {formatGbp(maxGbp)}
        </text>

        {labelIndices.map((index) => {
          const day = days[index];
          const point = points[index];
          if (day === undefined || point === undefined) return null;
          const anchor = index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle';
          return (
            <text
              key={day.date}
              x={point.x}
              y={CHART_HEIGHT - 8}
              textAnchor={anchor}
              className="fill-muted-foreground text-[10px]"
            >
              {formatDayMonth(day.date)}
            </text>
          );
        })}
      </svg>

      <table className="sr-only">
        <caption>Cost by day, most recent last</caption>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <td>{formatDayMonth(day.date)}</td>
              <td>{formatGbp(day.gbp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CostByDay({ days, ceilingGbp }: { days: CostByDay[]; ceilingGbp: number }) {
  const [view, setView] = useState<View>(DEFAULT_VIEW);

  useEffect(() => {
    const stored = readStoredView();
    if (stored !== null) setView(stored);
  }, []);

  const onChange = (next: View) => {
    setView(next);
    writeStoredView(next);
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">Cost by day</h2>
        <ViewToggle view={view} onChange={onChange} />
      </div>
      {view === 'table' ? (
        <CostTable days={days} />
      ) : (
        <CostGraph days={days} ceilingGbp={ceilingGbp} />
      )}
    </>
  );
}
