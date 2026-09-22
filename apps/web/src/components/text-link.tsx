import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from 'cn';

/**
 * An inline link. Brand peach by default, the foreground colour for links
 * that are a row's title, mono for ids. An `http` href renders a plain
 * anchor with `rel="noreferrer"`; everything else is a Next link.
 */
export function TextLink({
  href,
  tone = 'brand',
  mono = false,
  title,
  className,
  children,
}: {
  href: string;
  tone?: 'brand' | 'foreground' | 'muted';
  mono?: boolean;
  /** The full value when the visible text is shortened. */
  title?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const titleProp = title === undefined ? {} : { title };
  const classes = cn(
    'rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/45',
    tone === 'brand' && 'text-brand hover:text-[#f9e2d7]',
    tone === 'foreground' && 'text-foreground',
    tone === 'muted' && 'text-muted-foreground hover:text-foreground',
    mono && 'font-mono text-xs',
    className,
  );
  if (/^https?:\/\//.test(href)) {
    return (
      <a href={href} rel="noreferrer" className={classes} {...titleProp}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} {...titleProp}>
      {children}
    </Link>
  );
}
