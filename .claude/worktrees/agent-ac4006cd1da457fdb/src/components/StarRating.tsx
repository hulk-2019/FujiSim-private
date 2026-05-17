import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface StarRatingProps {
  value: number;
  onChange?: (v: number) => void;
  size?: number;
  className?: string;
}

export function StarRating({ value, onChange, size = 14, className }: StarRatingProps) {
  return (
    <div className={cn("inline-flex gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange?.(value === n ? 0 : n);
          }}
          className="text-zinc-500 hover:text-yellow-300 transition-colors"
          title={`${n} 星`}
        >
          <Star
            size={size}
            className={cn(
              "transition-colors",
              n <= value ? "fill-yellow-400 text-yellow-400" : "fill-transparent",
            )}
          />
        </button>
      ))}
    </div>
  );
}
