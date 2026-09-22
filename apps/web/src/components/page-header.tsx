import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { TextLink } from '@/components/text-link';

/**
 * The page title and its one-line summary sit on the canvas; filters and
 * tables are the cards (design index, decision 4). `actions` sits at the
 * end of the title row and `back` above it.
 */
export function PageHeader({
  title,
  summary,
  actions,
  back,
}: {
  title: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col gap-3">
      {back === undefined ? null : (
        <TextLink href={back.href} className="inline-flex items-center gap-1.5 self-start text-[13px]">
          <ArrowLeft aria-hidden className="size-3.5" />
          {back.label}
        </TextLink>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl leading-tight font-semibold">{title}</h1>
          {summary === undefined ? null : <p className="mt-1 text-muted-foreground">{summary}</p>}
        </div>
        {actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
        )}
      </div>
    </div>
  );
}
