import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  onThumbDoubleClick?: () => void;
};

export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, onThumbDoubleClick, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("relative flex w-full touch-none items-center select-none", className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-zinc-700">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      onDoubleClick={onThumbDoubleClick}
      className="block h-3.5 w-3.5 rounded-full border border-primary bg-primary-foreground shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
    />
  </SliderPrimitive.Root>
));
Slider.displayName = "Slider";
