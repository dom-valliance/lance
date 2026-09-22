import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { Slot } from 'radix-ui';

/**
 * Buttons in the four design variants and six states (design foundations,
 * section 5). Primary is the light fill with dark text; destructive is the
 * salmon fill with the page background as text, which reaches 7.9:1.
 * Disabled is opacity 50%; a locked policy cell is a different component.
 * The `lg` size is the 44px target the 360 layouts use.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/45 disabled:pointer-events-none disabled:opacity-50 aria-busy:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-[oklch(0.85_0_0)] active:bg-[oklch(0.78_0_0)]',
        outline:
          'border-input bg-transparent text-foreground hover:bg-muted active:bg-[oklch(0.32_0_0)] aria-expanded:bg-muted',
        ghost: 'text-foreground hover:bg-muted active:bg-[oklch(0.32_0_0)] aria-expanded:bg-muted',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-[oklch(0.64_0.19_22.216)] active:bg-[oklch(0.58_0.18_22.216)]',
        link: 'h-auto rounded-sm px-0 text-brand underline-offset-4 hover:text-[#f9e2d7] hover:underline',
      },
      size: {
        default: 'h-9 px-4',
        sm: "h-8 px-3 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-11 px-4',
        icon: 'size-9',
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
