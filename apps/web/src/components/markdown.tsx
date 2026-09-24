import type { ReactNode } from 'react';
import { cn } from 'cn';
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown';

/**
 * A document the repository ships, rendered from `parseMarkdown` as React
 * elements: nothing in the document reaches the page as HTML.
 */

const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'text-lg font-semibold',
  2: 'text-base font-semibold',
  3: 'text-sm font-semibold',
  4: 'text-sm font-medium',
};

function renderInline(inlines: Inline[]): ReactNode[] {
  return inlines.map((inline, index) => {
    switch (inline.kind) {
      case 'text':
        return inline.text;
      case 'strong':
        return <strong key={index}>{renderInline(inline.children)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(inline.children)}</em>;
      case 'code':
        return (
          <code key={index} className="rounded bg-muted px-1 font-mono text-[0.9em]">
            {inline.text}
          </code>
        );
      case 'link':
        return (
          <a
            key={index}
            href={inline.href}
            rel="noreferrer"
            className="text-brand underline-offset-4 hover:underline"
          >
            {renderInline(inline.children)}
          </a>
        );
    }
  });
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case 'heading': {
      // Document headings sit under the page's own h1 and the step's h2.
      const Tag = (['h3', 'h3', 'h4', 'h5'] as const)[block.level - 1] ?? 'h5';
      return (
        <Tag key={index} className={HEADING_CLASS[block.level]}>
          {renderInline(block.children)}
        </Tag>
      );
    }
    case 'paragraph':
      return <p key={index}>{renderInline(block.children)}</p>;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          key={index}
          className={cn('flex flex-col gap-1 pl-5', block.ordered ? 'list-decimal' : 'list-disc')}
        >
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
  }
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 text-sm leading-relaxed', className)}>
      {parseMarkdown(source).map(renderBlock)}
    </div>
  );
}
