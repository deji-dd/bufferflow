import { useEffect, useRef, useState } from 'react';

export function useAnimatedNumber(target: number, durationMs: number = 300): number {
  const [current, setCurrent] = useState(target);
  const currentRef = useRef(target);
  currentRef.current = current;

  useEffect(() => {
    const startVal = currentRef.current;
    const endVal = target;
    if (startVal === endVal) return;

    const startTime = performance.now();
    let animId: number;

    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / durationMs);
      // Cubic ease-out
      const ease = 1 - (1 - progress) ** 3;
      const nextVal = Math.round(startVal + (endVal - startVal) * ease);
      setCurrent(nextVal);

      if (progress < 1) {
        animId = requestAnimationFrame(step);
      } else {
        setCurrent(endVal);
      }
    };

    animId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animId);
  }, [target, durationMs]);

  return current;
}
