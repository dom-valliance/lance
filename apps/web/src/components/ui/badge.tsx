import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import type { Tone } from '@/lib/tones';

/**
 * A pill with a text label in one of the semantic tones (design
 * foundations, section 3). Fill at low alpha, text at the tone's tint, a
 * hairline at 30%. `dot` adds the 6px leading dot the watcher-health and
 * mode badges carry.
 */
const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-medium',
  {
    variants: {
      tone: {
        blue: 'border-sem-blue-line bg-sem-blue-bg text-sem-blue-fg',
        pink: 'border-sem-pink-line bg-sem-pink-bg text-sem-pink-fg',
        peach: 'border-sem-peach-line bg-sem-peach-bg text-sem-peach-fg',
        teal: 'border-sem-teal-line bg-sem-teal-bg text-sem-teal-fg',
        green: 'border-sem-green-line bg-sem-green-bg text-sem-green-fg',
        red: 'border-sem-red-line bg-sem-red-bg text-sem-red-fg',
        neutral: 'border-sem-neutral-line bg-sem-neutral-bg text-sem-neutral-fg',
        'neutral-strong': 'border-border bg-muted text-foreground',
        outline: 'border-input bg-transparent text-muted-foreground',
        'solid-red': 'border-transparent bg-sem-red-fg font-semibold text-background',
      } satisfies Record<Tone, string>,
      size: {
        default: 'h-[22px] px-2 text-xs',
        sm: 'h-5 px-[7px] text-[11px]',
        xs: 'h-[18px] px-1.5 text-[11px]',
      },
    },
    defaultVariants: {
      tone: 'neutral',
      size: 'default',
    },
  },
);

function Badge({
  className,
  tone = 'neutral',
  size = 'default',
  dot = false,
  children,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span
      data-slot="badge"
      data-tone={tone}
      className={cn(badgeVariants({ tone, size }), className)}
      {...props}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
