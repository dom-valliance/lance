import { cn } from 'cn';

/**
 * The reversed wordmark, derived from the supplied black-on-white JPEG
 * with an invert and a screen blend (design index, decision 10). A vector
 * asset replaces this image when one is supplied.
 */
export function Wordmark({ name, className }: { name: string; className?: string }) {
  return (
    <img
      src="/lance-logo.jpg"
      alt={name}
      className={cn('h-5 w-auto invert mix-blend-screen', className)}
    />
  );
}
