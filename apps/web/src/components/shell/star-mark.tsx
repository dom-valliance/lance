import { cn } from 'cn';

/** The four-point star from the wordmark's "a", on a 24px grid. */
export function StarMark({
  className,
  size = 20,
  title,
}: {
  className?: string;
  size?: number;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn('fill-current', className)}
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : 'img'}
    >
      {title === undefined ? null : <title>{title}</title>}
      <path d="M12 1.5C12 7.5 16.5 12 22.5 12 16.5 12 12 16.5 12 22.5 12 16.5 7.5 12 1.5 12 7.5 12 12 7.5 12 1.5Z" />
    </svg>
  );
}
