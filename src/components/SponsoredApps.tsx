import { useState, type MouseEvent } from "react";
import { ExternalLink } from "lucide-react";

import { openExternalLink } from "@/lib/app-links";
import { BRAND_INK, BRAND_TILE, MIN_MARK_CONTRAST, contrastRatio } from "@/lib/brand-icons";
import { t } from "@/lib/i18n";
import { sponsorSlot, type Sponsor, type SponsorSlot } from "@/lib/sponsors";

function openInBrowser(url: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (!window.laterdog?.openExternal) return;
    event.preventDefault();
    void openExternalLink(url);
  };
}

function SponsorMark({ sponsor }: { sponsor: Sponsor }) {
  const [failed, setFailed] = useState(false);
  const ink = sponsor.color && contrastRatio(sponsor.color, BRAND_TILE) >= MIN_MARK_CONTRAST ? sponsor.color : BRAND_INK;
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-[13px] ring-1 ring-inset ring-black/10 forced-color-adjust-none"
      style={{ backgroundColor: BRAND_TILE }}
    >
      {sponsor.icon && !failed ? (
        <img
          src={sponsor.icon}
          alt=""
          width={26}
          height={26}
          draggable={false}
          referrerPolicy="no-referrer"
          className="rounded-[22%] object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-[18px] font-semibold leading-none" style={{ color: ink }}>
          {sponsor.name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}

export function SponsoredApps({ slot = sponsorSlot() }: { slot?: SponsorSlot }) {
  if (slot.kind === "none") return null;
  if (slot.kind === "open") {
    return (
      <section data-apps-sponsored="open" aria-label={t("apps.sponsored.label")} className="pt-3">
        <a
          data-sponsor-cta
          href={slot.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={openInBrowser(slot.url)}
          className="flex items-center gap-2 rounded-2xl border border-dashed border-hairline px-4 py-3 text-[12.5px] text-ink-secondary transition-colors hover:bg-raised/50 hover:text-ink"
        >
          <span className="min-w-0 flex-1 truncate">{t("apps.sponsored.cta")}</span>
          <ExternalLink size={13} aria-hidden="true" className="shrink-0" />
        </a>
      </section>
    );
  }
  return (
    <section data-apps-sponsored="sponsors" aria-label={t("apps.sponsored.label")} className="@container pt-3">
      <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2">
        {slot.sponsors.map((sponsor) => (
          <a
            key={sponsor.url}
            data-sponsor={sponsor.name}
            href={sponsor.url}
            target="_blank"
            rel="sponsored noopener noreferrer"
            onClick={openInBrowser(sponsor.url)}
            className="glass-card flex min-w-0 items-center gap-3 rounded-2xl p-4 transition-colors hover:bg-raised/50"
          >
            <SponsorMark sponsor={sponsor} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[14px] font-medium text-ink">{sponsor.name}</span>
                <span className="shrink-0 rounded-full bg-control px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary">{t("apps.sponsored.label")}</span>
              </span>
              {sponsor.tagline && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink-secondary">{sponsor.tagline}</span>}
            </span>
            <ExternalLink size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          </a>
        ))}
      </div>
      {slot.url && (
        <div className="mt-1.5 flex justify-end">
          <a
            data-sponsor-link
            href={slot.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={openInBrowser(slot.url)}
            className="rounded-full px-2.5 py-1 text-[11.5px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
          >
            {t("apps.sponsored.join")}
          </a>
        </div>
      )}
    </section>
  );
}
