export function whenSeen(element: Element | null, seen: () => void, rootMargin = "320px 0px"): () => void {
  if (!element || typeof IntersectionObserver === "undefined") {
    seen();
    return () => {};
  }
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting) return;
    observer.disconnect();
    seen();
  }, { rootMargin });
  observer.observe(element);
  return () => observer.disconnect();
}
