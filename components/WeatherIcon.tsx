"use client";

/**
 * Weather symbols for the forecast strip.
 *
 * WHY DRAW THEM RATHER THAN USE THE ONES THE APIS SHIP.
 * NWS returns an `icon` URL, and it would be one line to point an `<img>` at
 * it. Three reasons not to: the images are fixed-colour PNGs that look wrong on
 * a dark ground, they are a third-party request on every tile, and days 8-16
 * come from Open-Meteo which ships no icons at all — so half the panel would
 * have pictures and half would not.
 *
 * WHY TWO SYMBOLS PER DAY.
 * Sky on the left beside the temperature, water on the right beside the chance
 * of rain. That is the split every consumer weather app uses, and it matches
 * how the tile is actually read: "how hot" and "will it rain" are two separate
 * questions, and a single glyph forces one to win. A day can be sunny AND carry
 * a 30% afternoon thunderstorm, which is the most common summer afternoon in
 * Texas and exactly the case one symbol cannot state.
 *
 * The vocabulary is the National Weather Service's own, which is also what
 * Google and Apple print: Sunny, Mostly Sunny, Partly Cloudy, Mostly Cloudy,
 * Cloudy, Showers, Thunderstorms, Rain, Snow, Fog, Windy.
 */

export type Sky =
  | "sun"
  | "partly"
  | "mostly-cloudy"
  | "cloud"
  | "rain"
  | "showers"
  | "thunder"
  | "snow"
  | "fog"
  | "wind";

export type Wet = "none" | "rain" | "thunder" | "snow";

const STROKE = {
  fill: "none",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.7,
};

/** Shared cloud body, so every cloudy variant sits at the same place. */
function Cloud({ color }: { color: string }) {
  return (
    <path
      d="M7.2 18.2h9.3a3.4 3.4 0 0 0 .35-6.78 5.1 5.1 0 0 0-9.72-1.2 3.9 3.9 0 0 0 .07 7.98Z"
      stroke={color}
      {...STROKE}
    />
  );
}

function SunDisc({ cx, cy, r, color }: { cx: number; cy: number; r: number; color: string }) {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
    const a = (deg * Math.PI) / 180;
    const i = r + 1.9;
    const o = r + 4.1;
    return (
      <line
        key={deg}
        x1={cx + Math.cos(a) * i}
        y1={cy + Math.sin(a) * i}
        x2={cx + Math.cos(a) * o}
        y2={cy + Math.sin(a) * o}
        stroke={color}
        {...STROKE}
      />
    );
  });
  return (
    <>
      <circle cx={cx} cy={cy} r={r} stroke={color} {...STROKE} />
      {rays}
    </>
  );
}

function Drops({ color, xs, y = 19.4 }: { color: string; xs: number[]; y?: number }) {
  return (
    <>
      {xs.map((x) => (
        <line key={x} x1={x} y1={y} x2={x - 1.1} y2={y + 2.8} stroke={color} {...STROKE} />
      ))}
    </>
  );
}

/**
 * One sky symbol.
 *
 * `warm` and `cool` are passed in rather than hard-coded so the caller can hand
 * over theme tokens — the sun takes the warm accent, water takes the cool one,
 * and cloud outlines take the surrounding text colour. Nothing here depends on
 * a stylesheet, because these are also serialised into the figure exports where
 * `var()` does not resolve.
 */
export function SkyIcon({
  sky,
  size = 22,
  warm = "#eda100",
  cool = "#2a78d6",
  neutral = "currentColor",
}: {
  sky: Sky;
  size?: number;
  warm?: string;
  cool?: string;
  neutral?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {sky === "sun" && <SunDisc cx={12} cy={12} r={4.4} color={warm} />}

      {sky === "partly" && (
        <>
          <SunDisc cx={9} cy={8.6} r={3.3} color={warm} />
          <Cloud color={neutral} />
        </>
      )}

      {sky === "mostly-cloudy" && (
        <>
          <circle cx={16.4} cy={7} r={2.5} stroke={warm} {...STROKE} />
          <Cloud color={neutral} />
        </>
      )}

      {sky === "cloud" && <Cloud color={neutral} />}

      {(sky === "rain" || sky === "showers") && (
        <>
          <Cloud color={neutral} />
          <Drops color={cool} xs={sky === "rain" ? [9.4, 12.6, 15.8] : [10.4, 14.6]} />
        </>
      )}

      {sky === "thunder" && (
        <>
          <Cloud color={neutral} />
          {/*
            The bolt OVERLAPS the cloud rather than hanging below it.

            Tucked underneath it only had the 5px between the cloud's base and
            the edge of the box, and at the 22px this renders at that was
            invisible — the tile for "Slight Chance Showers And Thunderstorms"
            was indistinguishable from plain cloud. Filled, not stroked, for the
            same reason: a 1.7px outline of a 6px shape is mostly outline.
          */}
          <path d="M13.9 9.2 9.1 16.4h3.1l-1.3 6.4 5.1-7.7h-3.4l1.3-5.9Z" fill={warm} />
        </>
      )}

      {sky === "snow" && (
        <>
          <Cloud color={neutral} />
          {[9.6, 12.4, 15.2].map((x) => (
            <g key={x} stroke={cool} {...STROKE}>
              <line x1={x - 1.1} y1={21} x2={x + 1.1} y2={21} />
              <line x1={x} y1={19.9} x2={x} y2={22.1} />
            </g>
          ))}
        </>
      )}

      {sky === "fog" && (
        <>
          <Cloud color={neutral} />
          <line x1={6.6} y1={21} x2={14.2} y2={21} stroke={cool} {...STROKE} />
          <line x1={9.8} y1={23.4} x2={17.4} y2={23.4} stroke={cool} {...STROKE} />
        </>
      )}

      {sky === "wind" && (
        <g stroke={neutral} {...STROKE}>
          <path d="M3 9h11.5a2.6 2.6 0 1 0-2.6-2.6" />
          <path d="M3 14h15a2.6 2.6 0 1 1-2.6 2.6" />
          <path d="M3 19h8" />
        </g>
      )}
    </svg>
  );
}

/** The right-hand symbol: what would fall, if anything. */
export function WetIcon({
  wet,
  size = 15,
  cool = "#2a78d6",
  warm = "#eda100",
}: {
  wet: Wet;
  size?: number;
  cool?: string;
  warm?: string;
}) {
  if (wet === "none") return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {wet === "rain" && (
        <path
          d="M12 3.2c3.4 4.3 5.6 7.3 5.6 10a5.6 5.6 0 0 1-11.2 0c0-2.7 2.2-5.7 5.6-10Z"
          stroke={cool}
          {...STROKE}
        />
      )}
      {wet === "thunder" && (
        <path d="M13.8 2.4 6.6 13.6h4.8l-1.6 8 7.6-11.8h-5.1l1.5-7.4Z" stroke={warm} {...STROKE} />
      )}
      {wet === "snow" && (
        <g stroke={cool} {...STROKE}>
          <line x1={12} y1={3} x2={12} y2={21} />
          <line x1={4.2} y1={7.5} x2={19.8} y2={16.5} />
          <line x1={4.2} y1={16.5} x2={19.8} y2={7.5} />
        </g>
      )}
    </svg>
  );
}

/**
 * NWS gives a phrase, not a code, so this reads the phrase.
 *
 * Order matters and is not alphabetical: "Chance Showers And Thunderstorms"
 * contains both "showers" and "thunderstorms", and a grower planning a spray
 * day needs the thunderstorm, so thunder is tested first. Same reasoning down
 * the list — the more consequential word wins.
 */
export function skyFromPhrase(phrase: string): { sky: Sky; wet: Wet } {
  const s = phrase.toLowerCase();
  if (s.includes("thunder") || s.includes("t-storm")) return { sky: "thunder", wet: "thunder" };
  if (s.includes("snow") || s.includes("sleet") || s.includes("flurries")) {
    return { sky: "snow", wet: "snow" };
  }
  if (s.includes("freezing") || s.includes("ice")) return { sky: "snow", wet: "snow" };
  if (s.includes("shower") || s.includes("drizzle")) return { sky: "showers", wet: "rain" };
  if (s.includes("rain")) return { sky: "rain", wet: "rain" };
  if (s.includes("fog") || s.includes("haze") || s.includes("smoke")) {
    return { sky: "fog", wet: "none" };
  }
  if (s.includes("wind") || s.includes("breezy") || s.includes("blustery")) {
    return { sky: "wind", wet: "none" };
  }
  if (s.includes("mostly cloudy") || s.includes("overcast")) {
    return { sky: "mostly-cloudy", wet: "none" };
  }
  if (s.includes("cloudy")) return { sky: "cloud", wet: "none" };
  if (s.includes("partly sunny") || s.includes("partly")) return { sky: "partly", wet: "none" };
  if (s.includes("mostly sunny") || s.includes("mostly clear")) {
    return { sky: "partly", wet: "none" };
  }
  if (s.includes("sunny") || s.includes("clear") || s.includes("fair")) {
    return { sky: "sun", wet: "none" };
  }
  return { sky: "cloud", wet: "none" };
}

/**
 * WMO 4677, which is what Open-Meteo publishes for days 8-16.
 *
 * Deliberately coarse. The code set distinguishes "slight" from "moderate"
 * drizzle; nine days out that difference is well inside the model's error, and
 * drawing it would claim a precision the forecast does not have.
 */
export function skyFromCode(code: number | null): { sky: Sky; wet: Wet } {
  if (code === null || !Number.isFinite(code)) return { sky: "cloud", wet: "none" };
  if (code >= 95) return { sky: "thunder", wet: "thunder" }; // 95, 96, 99
  if (code >= 80) return { sky: "showers", wet: "rain" }; // 80-82 rain showers, 85-86 snow showers
  if (code >= 71 && code <= 77) return { sky: "snow", wet: "snow" };
  if (code >= 61 && code <= 67) return { sky: "rain", wet: "rain" };
  if (code >= 51 && code <= 57) return { sky: "showers", wet: "rain" };
  if (code === 45 || code === 48) return { sky: "fog", wet: "none" };
  if (code === 3) return { sky: "cloud", wet: "none" };
  if (code === 2) return { sky: "mostly-cloudy", wet: "none" };
  if (code === 1) return { sky: "partly", wet: "none" };
  if (code === 0) return { sky: "sun", wet: "none" };
  return { sky: "cloud", wet: "none" };
}

/** NWS-style wording for a WMO code, so both tiers speak one vocabulary. */
export function phraseFromCode(code: number | null): string {
  if (code === null || !Number.isFinite(code)) return "—";
  if (code >= 95) return "Thunderstorms";
  if (code >= 85) return "Snow showers";
  if (code >= 80) return "Showers";
  if (code >= 71) return "Snow";
  if (code >= 66) return "Freezing rain";
  if (code >= 61) return "Rain";
  if (code >= 51) return "Drizzle";
  if (code === 45 || code === 48) return "Fog";
  if (code === 3) return "Cloudy";
  if (code === 2) return "Partly cloudy";
  if (code === 1) return "Mostly sunny";
  if (code === 0) return "Sunny";
  return "—";
}
