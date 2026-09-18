"use client";

import { convert, unitLabel, fToC, type UnitSystem } from "@/lib/agro/units";

/**
 * The grower's own growing-degree-day base temperature.
 *
 * Shown only when the crop selector is set to "Custom base temperature", and
 * placed immediately beside that selector in both places it appears — picking
 * "custom" and then having to hunt for where to type the number would be worse
 * than not offering it.
 *
 * WHY A CAP IS OFFERED AT ALL, AND WHY IT IS OPTIONAL. The two GDD methods
 * differ by exactly one thing: whether the daily high is capped before
 * averaging. Corn is capped because a kernel stops filling in extreme heat;
 * bermuda grass is not, because it keeps growing. Rather than asking the reader
 * to choose a "method" — a word that explains nothing — leaving the cap blank
 * gives the simple method and filling it in gives the modified one. The label
 * says what it does.
 *
 * Values are held in Celsius by the caller and converted here only for display,
 * the same rule the whole app follows. See lib/agro/units.ts.
 */

interface Props {
  units: UnitSystem;
  /** Base temperature in degC. */
  baseC: number;
  /** Upper cap in degC, or null for no cap (the simple method). */
  capC: number | null;
  onBaseChange: (degC: number) => void;
  onCapChange: (degC: number | null) => void;
}

export default function GddBaseInput({ units, baseC, capC, onBaseChange, onCapChange }: Props) {
  const u = unitLabel("temp", units);
  const toDisplay = (c: number) => Math.round(convert(c, "temp", units));
  const toMetric = (shown: number) => (units === "imperial" ? fToC(shown) : shown);

  return (
    <div className="gdd-custom">
      <label>
        <span>Base</span>
        <input
          type="number"
          inputMode="decimal"
          aria-label={`Growing degree day base temperature in ${u}`}
          value={toDisplay(baseC)}
          /*
             Bounds are wide on purpose. Real base temperatures run from around
             freezing for cool-season grasses to the high teens Celsius for some
             tropical species, and a range tuned to Texas row crops would refuse
             a legitimate value from someone who knows better than this input
             does. They only stop a typo becoming a silently absurd chart.
          */
          min={units === "imperial" ? 20 : -5}
          max={units === "imperial" ? 80 : 27}
          step={1}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onBaseChange(toMetric(n));
          }}
        />
        <span className="gdd-unit">{u}</span>
      </label>

      <label>
        <span>Cap at</span>
        <input
          type="number"
          inputMode="decimal"
          aria-label={`Upper cap temperature in ${u}, leave blank for no cap`}
          value={capC === null ? "" : toDisplay(capC)}
          placeholder="none"
          min={units === "imperial" ? 60 : 15}
          max={units === "imperial" ? 120 : 49}
          step={1}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === "") {
              onCapChange(null);
              return;
            }
            const n = Number(raw);
            if (Number.isFinite(n)) onCapChange(toMetric(n));
          }}
        />
        <span className="gdd-unit">{u}</span>
      </label>

      <p className="gdd-hint">
        {capC === null
          ? "No cap: every degree above the base counts."
          : `Days hotter than ${toDisplay(capC)}${u} count as ${toDisplay(capC)}${u}.`}
      </p>
    </div>
  );
}
