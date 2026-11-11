import { cn } from "@/lib/cn";
import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
import { type MentionPeer } from "@/lib/mentions";
import { textBoxHeightCanChange, type MeasuredTextBox } from "@/lib/textarea-height";
import { MentionText } from "./MentionText";

export function MentionTextarea({ inputRef, peers, everyone = false, wrapperClassName, ghost, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  wrapperClassName?: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  peers: readonly MentionPeer[];
  everyone?: boolean;
  ghost?: ReactNode;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const sync = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    mirror.style.width = `${input.clientWidth}px`;
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  }, [inputRef]);
  const measuredRef = useRef<MeasuredTextBox | null>(null);
  const resize = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 24;
    const value = input.value;
    if (textBoxHeightCanChange(measuredRef.current, { value, lineHeight, width: input.clientWidth }, () => input.scrollHeight > input.clientHeight)) {
      const scrollTop = input.scrollTop;
      const tallest = lineHeight * 6;
      input.style.height = "auto";
      const wanted = input.scrollHeight;
      const smallest = wanted <= input.clientHeight;
      input.style.height = `${Math.min(wanted, tallest)}px`;
      input.scrollTop = scrollTop;
      measuredRef.current = { value, lineHeight, width: input.clientWidth, smallest, tallest: wanted >= tallest };
    }
    sync();
  }, [inputRef, sync]);
  useLayoutEffect(resize, [props.value, resize]);
  useLayoutEffect(() => {
    let width = inputRef.current?.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = inputRef.current?.clientWidth;
      if (nextWidth !== width) { width = nextWidth; resize(); }
      else sync();
    });
    if (inputRef.current) observer.observe(inputRef.current);
    return () => observer.disconnect();
  }, [inputRef, resize, sync]);
  return <div className={cn("mention-editor relative min-w-0 flex-1 self-center", wrapperClassName)}>
    <div ref={mirrorRef} dir={props.dir} aria-hidden="true" className="mention-editor-mirror pointer-events-none absolute inset-0 overflow-hidden">
      <MentionText text={String(props.value ?? "")} peers={peers} everyone={everyone} />{ghost}{"\n"}
    </div>
    <textarea {...props} ref={inputRef} onScroll={(event) => { sync(); props.onScroll?.(event); }} />
  </div>;
}
