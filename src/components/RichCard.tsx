import { useState } from "react";
import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSun, MapPin, Navigation, ShoppingBag, Snowflake, Sun, Wind, type LucideIcon } from "lucide-react";
import { t } from "@/lib/i18n";
import { degrees, directions, sky, type PlaceCard, type ProductCard, type RichCard as Card, type Sky, type WeatherCard } from "@/lib/rich-cards";

const SKY_ICON: Record<Sky, LucideIcon> = {
  sun: Sun,
  partly: CloudSun,
  cloud: Cloud,
  rain: CloudRain,
  storm: CloudLightning,
  snow: Snowflake,
  fog: CloudFog,
  wind: Wind,
};

const FRAME = "my-2 w-full max-w-[420px] rounded-card bg-card px-3.5 py-3 ring-[0.5px] ring-ink/10";
const BUTTON = "inline-flex items-center gap-1.5 rounded-full bg-control px-3 py-1 text-[12.5px] text-ink transition-colors hover:bg-control-hover";

function Place({ card }: { card: PlaceCard }) {
  const links = directions(card);
  return (
    <div className={FRAME} data-rich-card="place">
      <div className="flex items-start gap-2.5">
        <MapPin size={18} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{card.name}</div>
          {card.address && <div className="text-[13px] text-ink-secondary">{card.address}</div>}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <a href={links.apple} target="_blank" rel="noreferrer" className={BUTTON}><Navigation size={13} aria-hidden="true" />{t("richCard.appleMaps")}</a>
        <a href={links.google} target="_blank" rel="noreferrer" className={BUTTON}><Navigation size={13} aria-hidden="true" />{t("richCard.googleMaps")}</a>
      </div>
    </div>
  );
}

function Product({ card }: { card: ProductCard }) {
  const [pictured, setPictured] = useState(Boolean(card.image));
  return (
    <div className={FRAME} data-rich-card="product">
      <div className="flex items-start gap-3">
        {pictured && card.image
          ? <img src={card.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setPictured(false)} className="size-16 shrink-0 rounded-lg bg-inset object-contain" />
          : <ShoppingBag size={18} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />}
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{card.name}</div>
          {(card.price || card.store) && (
            <div className="text-[13px] text-ink-secondary">{[card.price, card.store].filter(Boolean).join(" · ")}</div>
          )}
        </div>
      </div>
      {card.url && (
        <div className="mt-2.5">
          <a href={card.url} target="_blank" rel="noreferrer" className={BUTTON}><ShoppingBag size={13} aria-hidden="true" />{t("richCard.buy")}</a>
        </div>
      )}
    </div>
  );
}

function Weather({ card }: { card: WeatherCard }) {
  const NowIcon = SKY_ICON[sky(card.now?.condition ?? card.days[0]?.condition)];
  return (
    <div className={FRAME} data-rich-card="weather">
      <div className="text-[13px] text-ink-secondary">{card.place}</div>
      {card.now && (
        <div className="mt-1 flex items-center gap-2.5">
          <NowIcon size={26} className="shrink-0 text-ink" aria-hidden="true" />
          <span className="text-[26px] font-medium leading-none text-ink">{degrees(card.now.temp, card.unit)}</span>
          {card.now.condition && <span className="text-[13.5px] text-ink-secondary">{card.now.condition}</span>}
        </div>
      )}
      {card.days.length > 0 && (
        <div className="mt-2.5 flex gap-1 overflow-x-auto">
          {card.days.map((day, index) => {
            const DayIcon = SKY_ICON[sky(day.condition)];
            return (
              <div key={`${day.day}-${index}`} className="flex min-w-[52px] flex-col items-center gap-1 rounded-lg bg-inset px-1.5 py-1.5" title={day.condition}>
                <span className="text-[11.5px] text-ink-secondary">{day.day}</span>
                <DayIcon size={16} className="text-ink" aria-label={day.condition ?? undefined} />
                <span className="text-[12px] text-ink">{degrees(day.high, card.unit)}</span>
                <span className="text-[11.5px] text-ink-tertiary">{degrees(day.low, card.unit)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RichCard({ card }: { card: Card }) {
  if (card.kind === "place") return <Place card={card} />;
  if (card.kind === "product") return <Product card={card} />;
  return <Weather card={card} />;
}
