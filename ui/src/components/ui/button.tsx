import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg text-sm font-medium whitespace-nowrap transition-all outline-none select-none cursor-pointer disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[#00f0ff]/50 focus-visible:ring-offset-1 active:not-aria-[haspopup]:scale-[0.98] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-[#00f0ff] hover:bg-[#22f3ff] text-[#030810] font-bold shadow-[0_0_16px_rgba(0,240,255,0.3)] border border-transparent',
        outline:
          'bg-white/5 hover:bg-white/10 text-white border border-white/10 hover:text-white shadow-xs',
        secondary: 'bg-white/10 hover:bg-white/20 text-white border border-white/15 shadow-xs',
        ghost:
          'bg-transparent hover:bg-white/10 text-[#94a3b8] hover:text-white border border-transparent',
        destructive:
          'bg-[#f43f5e] hover:bg-[#ff4d6d] text-white font-bold shadow-[0_0_16px_rgba(244,63,94,0.4)] border border-transparent',
        'destructive-subtle':
          'bg-[#f43f5e]/20 hover:bg-[#f43f5e] text-[#f43f5e] hover:text-white border border-[#f43f5e]/40 font-semibold',
        'cyan-subtle':
          'bg-[#00f0ff]/15 hover:bg-[#00f0ff]/25 text-[#00f0ff] border border-[#00f0ff]/40 shadow-[0_0_12px_rgba(0,240,255,0.2)] font-bold',
        success:
          'bg-[#10b981] hover:bg-[#059669] text-white font-bold shadow-[0_0_12px_rgba(16,185,129,0.5)] border border-transparent',
        'success-subtle':
          'bg-[#10b981]/20 hover:bg-[#10b981] text-[#10b981] hover:text-white border border-[#10b981]/40 font-semibold',
        purple:
          'bg-[#a855f7]/30 hover:bg-[#a855f7]/40 text-[#a855f7] border border-[#a855f7]/60 shadow-[0_0_8px_rgba(168,85,247,0.4)] font-bold',
        gradient:
          'bg-gradient-to-r from-[#a855f7] via-[#ec4899] to-[#00f0ff] hover:brightness-110 !text-white font-bold shadow-md hover:shadow-lg border-0 border-none outline-none overflow-hidden',
        link: 'text-[#00f0ff] underline-offset-4 hover:underline border border-transparent',
      },
      size: {
        default: 'h-9 px-4 py-2 text-xs font-semibold',
        xs: 'h-6 px-2 py-0.5 text-[10px] rounded',
        sm: 'h-7.5 px-3 py-1.5 text-xs rounded-lg',
        lg: 'h-10 px-4 py-2.5 text-xs rounded-lg',
        icon: 'size-8 p-0 rounded-lg',
        'icon-xs': 'size-6 p-0 text-[10px] rounded',
        'icon-sm': 'size-7 p-0 text-xs rounded-lg',
        'icon-lg': 'size-9 p-0 rounded-lg',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
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
