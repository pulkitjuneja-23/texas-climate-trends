import type { SourceMeta, WeatherSource } from "@/lib/types";
import nasapower from "./nasapower";
import gridmet from "./gridmet";
import daymet from "./daymet";
import stations from "./stations";

/**
 * The source registry.
 *
 * Every other farmer-facing climate tool picks a dataset for you and hides it,
 * while dataset choice measurably changes the answer. So the picker is a
 * first-class control here.
 *
 * To add one: implement WeatherSource, drop it in LIVE_SOURCES. Nothing
 * downstream changes.
 */

/**
 * Sources offered in the picker.
 *
 * Open-Meteo is deliberately NOT here. It is still used throughout the app —
 * for the days 8-16 forecast — but as a historical source it duplicated what
 * the others do while reading consistently wettest at Texas locations (it
 * missed the 2022 drought by ~15 in against the gauge). Keeping it in the
 * picker offered the grower a worse answer with no way to know it was worse.
 * `lib/sources/openmeteo.ts` stays; only its registry entry is gone.
 *
 * PRISM was removed from the list entirely: its public service only serves
 * whole-CONUS daily rasters, so a 25-year point series would be ~36,000
 * downloads. gridMET is the substitute — same 4 km grid, and built on PRISM.
 */
const LIVE_SOURCES: WeatherSource[] = [gridmet, nasapower, daymet, stations];

const PLANNED: SourceMeta[] = [];

const BY_ID = new Map(LIVE_SOURCES.map((s) => [s.meta.id, s]));

export function getSource(id: string): WeatherSource {
  const s = BY_ID.get(id);
  if (!s) {
    throw new Error(
      `Unknown or unavailable source "${id}". Available: ${[...BY_ID.keys()].join(", ")}`
    );
  }
  return s;
}

export function listSources(): SourceMeta[] {
  return [...LIVE_SOURCES.map((s) => s.meta), ...PLANNED];
}

// Re-exported for server code; the value lives in `defaults.ts` so the client
// can read it without importing any source module. See that file.
export { DEFAULT_SOURCE_ID } from "./defaults";
