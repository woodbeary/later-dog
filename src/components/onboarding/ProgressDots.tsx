import { cn } from "@/lib/cn";

const SLOT = 16;
const GAP = 6;

export function ProgressDots({
  items,
  index,
  onSelect,
  label,
}: {
  items: Array<{ id: string; label?: string }>;
  index: number;
  onSelect?: (index: number) => void;
  label?: string;
}) {
  const interactive = Boolean(onSelect);
  return (
    <div
      className="relative flex items-center"
      style={{ gap: GAP, height: 14 }}
      role={interactive ? "tablist" : undefined}
      aria-label={interactive ? label : undefined}
      aria-hidden={interactive ? undefined : true}
    >
      <span
        className="pointer-events-none absolute left-0 top-1/2 h-1.5 rounded-full bg-ink transition-transform duration-(--motion-enter) ease-(--ease-out-soft)"
        style={{ width: SLOT, transform: `translate(${index * (SLOT + GAP)}px, -50%)` }}
        aria-hidden="true"
      />
      {items.map((item, i) => {
        const dot = (
          <span
            className={cn(
              "size-1.5 rounded-full transition-[background-color,opacity] duration-(--motion-enter)",
              i === index ? "opacity-0" : i < index ? "bg-ink-secondary" : "bg-hairline",
            )}
          />
        );
        return interactive ? (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={item.label ?? item.id}
            onClick={() => onSelect?.(i)}
            className="flex h-3.5 items-center justify-center rounded-full"
            style={{ width: SLOT }}
          >
            {dot}
          </button>
        ) : (
          <span key={item.id} className="flex h-3.5 items-center justify-center" style={{ width: SLOT }}>
            {dot}
          </span>
        );
      })}
    </div>
  );
}
