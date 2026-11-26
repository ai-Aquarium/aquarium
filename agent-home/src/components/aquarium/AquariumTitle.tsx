import { BoxLogo } from "@/components/brand/BoxLogo";

const WAVE_S = 4.8;
const CHAR_DELAY_S = 0.08;
const BUBBLES = [
  { left: 3, size: 6, delay: 0 },
  { left: 14, size: 4, delay: 2.2 },
  { left: 47, size: 5, delay: 3.6 },
  { left: 86, size: 4, delay: 1.1 },
  { left: 97, size: 7, delay: 2.9 },
] as const;

/** Long unbroken runs (e.g. CJK names) may wrap anywhere; shorter words stay whole. */
const NOWRAP_MAX = 16;

/**
 * The aquarium's name over the tank, after the box logo (`BoxLogo`): each
 * letter rides a slow wave of light, with a few bubbles rising off it. CSS
 * only (`.aq-title*` in globals.css); reduced motion keeps it still. Long
 * names end in an ellipsis (one line on phones, two wider up). The animated letters are hidden from assistive
 * tech, which reads the plain name.
 */
export function AquariumTitle({ name }: { name: string }) {
  let index = 0;
  const words = name.split(/(\s+)/).filter(Boolean);
  return (
    <h1
      data-component="AquariumTitle"
      title={name}
      className="aq-title relative inline-flex max-w-full items-center gap-2.5 rounded-full bg-[rgb(3_24_52/0.38)] py-1 pr-5 pl-2 text-left text-2xl font-extrabold leading-tight tracking-wide text-white shadow-[0_8px_32px_rgb(0_10_30/0.35)] ring-1 ring-white/15 backdrop-blur-sm sm:pl-2.5 sm:text-4xl"
    >
      <span data-component="AquariumTitleLogo" className="flex shrink-0 drop-shadow-[0_2px_8px_rgb(0_20_50/0.45)]">
        <BoxLogo size={32} />
      </span>
      <span className="sr-only">{name}</span>
      <span aria-hidden className="line-clamp-1 min-w-0 sm:line-clamp-2 py-[0.12em] [overflow-wrap:anywhere]">
        {words.map((word, w) => {
          if (/^\s+$/.test(word)) return " ";
          const chars = Array.from(word);
          return (
            <span key={w} className={chars.length <= NOWRAP_MAX ? "whitespace-nowrap" : undefined}>
              {chars.map((ch) => {
                const delay = ((index++ * CHAR_DELAY_S) % WAVE_S).toFixed(2);
                return (
                  <span key={index} className="aq-title-char" style={{ animationDelay: `${delay}s` }}>
                    {ch}
                  </span>
                );
              })}
            </span>
          );
        })}
      </span>
      {BUBBLES.map((b, i) => (
        <span
          key={i}
          aria-hidden
          className="aq-title-bubble"
          style={{ left: `${b.left}%`, width: b.size, height: b.size, animationDelay: `${b.delay}s` }}
        />
      ))}
    </h1>
  );
}
