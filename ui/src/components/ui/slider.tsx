import { Slider as SliderPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  rangeClassName,
  thumbClassName,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  rangeClassName?: string;
  thumbClassName?: string;
}) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]),
    [value, defaultValue, min, max]
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        'relative flex w-full touch-none items-center select-none cursor-pointer py-1.5 data-disabled:opacity-40 data-disabled:cursor-not-allowed',
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative grow overflow-hidden rounded-full bg-white/10 h-1.5 w-full cursor-pointer"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn('absolute h-full bg-[#00f0ff] select-none', rangeClassName)}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className={cn(
            'relative block size-3.5 shrink-0 rounded-full border-2 border-white bg-[#030810] shadow-[0_0_8px_rgba(0,240,255,0.5)] transition-transform select-none cursor-pointer hover:scale-125 focus-visible:outline-hidden active:scale-125 disabled:pointer-events-none disabled:opacity-50',
            thumbClassName
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
