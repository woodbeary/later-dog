import { useEffect, useState } from "react";
import { openExternalLink } from "@/lib/app-links";
import { fetchLinkPreview, linkHost, previewLinks, type LinkPreview } from "@/lib/link-previews";

function LinkPreviewCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [pictured, setPictured] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void fetchLinkPreview(url).then((found) => { if (!cancelled) setPreview(found); });
    return () => { cancelled = true; };
  }, [url]);
  if (!preview) return null;
  return (
    <button type="button" onClick={() => void openExternalLink(url)} data-link-preview={url} title={url}
      className="mt-2 flex w-full max-w-[460px] items-stretch gap-3 overflow-hidden rounded-card bg-card p-2.5 text-left ring-[0.5px] ring-ink/10 transition-colors hover:bg-raised">
      {preview.image && pictured && (
        <img src={preview.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setPictured(false)}
          className="size-16 shrink-0 rounded-lg bg-inset object-cover" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-ink-secondary">{preview.site ?? linkHost(url)}</span>
        <span className="line-clamp-2 text-[13.5px] font-medium leading-snug text-ink">{preview.title}</span>
        {preview.description && <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink-secondary">{preview.description}</span>}
      </span>
    </button>
  );
}

export function LinkPreviews({ text }: { text: string }) {
  const links = previewLinks(text);
  if (!links.length) return null;
  return <div data-link-previews>{links.map((url) => <LinkPreviewCard key={url} url={url} />)}</div>;
}
