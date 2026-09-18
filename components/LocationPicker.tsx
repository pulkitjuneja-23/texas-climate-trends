"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Place } from "@/lib/types";
import { TEXAS_CENTER, parseCoords } from "@/lib/geo";
import type { PickMethod } from "@/lib/analytics/visitor";

/**
 * Leaflet touches `window` at import time, so the map must be client-only.
 */
const MapCanvas = dynamic(() => import("./MapCanvas"), {
  ssr: false,
  loading: () => <div className="map-shell skeleton" />,
});

type Mode = "search" | "coords";

interface Props {
  place: Place;
  /**
   * `via` says which of the four ways the grower used to get here. It is
   * telemetry context only — nothing on screen depends on it — which is why it
   * is optional and defaulted rather than threaded through as required.
   */
  onChange: (p: Place, via?: PickMethod) => void;
  /** Grid cell of the active source, drawn on the map. Null for stations. */
  cellSize?: { lat: number; lon: number } | null;
  /** Crop the GDD base belongs to — the one non-location setting in this card. */
  gddPresetKey?: string;
  gddPresets?: Record<string, { label: string; short: string }>;
  onGddPresetChange?: (key: string) => void;
  /**
   * The real instrument supplying the most recent days.
   *
   * Shown under the map opposite the coordinates, because it is provenance for
   * THIS point — the same class of fact as which cell was read — rather than a
   * figure belonging in the season card.
   */
  station?: { id: string; name: string; distanceKm: number } | null;
}

interface SearchHit {
  label: string;
  lat: number;
  lon: number;
  county?: string;
}

export default function LocationPicker({
  place,
  onChange,
  cellSize = null,
  gddPresetKey,
  gddPresets,
  onGddPresetChange,
  station = null,
}: Props) {
  const [mode, setMode] = useState<Mode>("search");
  const [query, setQuery] = useState("");
  const [coordText, setCoordText] = useState("");
  const [coordError, setCoordError] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  /** Set once a search has run, so "no matches" can be reported instead of silence. */
  const [searched, setSearched] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  /**
   * Search runs on SUBMIT ONLY, never as the user types — the OpenStreetMap
   * Nominatim usage policy forbids using the public service for autocomplete
   * and caps requests at one per second. Results are cached per query so a
   * repeated lookup costs nothing.
   */
  const cacheRef = useRef<Map<string, SearchHit[]>>(new Map());

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function runSearch() {
    const q = query.trim();
    if (q.length < 3) return;

    const cached = cacheRef.current.get(q.toLowerCase());
    if (cached) {
      setHits(cached);
      setSearched(true);
      setOpen(true);
      return;
    }

    setSearching(true);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      const results: SearchHit[] = json.results ?? [];
      cacheRef.current.set(q.toLowerCase(), results);
      setHits(results);
    } catch {
      setHits([]);
    } finally {
      setSearched(true);
      setOpen(true);
      setSearching(false);
    }
  }

  function choose(h: SearchHit) {
    onChange({ lat: h.lat, lon: h.lon, label: h.label, county: h.county }, "search");
    setQuery("");
    setHits([]);
    setOpen(false);
  }

  /**
   * `via` is carried through both calls because this fires onChange twice — the
   * coordinate label first so the map responds immediately, then the real place
   * name once Nominatim answers. The second call has the same coordinates, so
   * the visit beacon does not fire again; passing `via` anyway keeps the two
   * consistent if that ever changes.
   */
  async function reverseLabel(lat: number, lon: number, fallback: string, via: PickMethod) {
    onChange({ lat, lon, label: fallback }, via);
    try {
      const res = await fetch(`/api/geocode?lat=${lat}&lon=${lon}`);
      const json = await res.json();
      const hit = json.results?.[0];
      if (hit?.label) onChange({ lat, lon, label: hit.label, county: hit.county }, via);
    } catch {
      /* keep the coordinate label */
    }
  }

  function handleMapPick(lat: number, lon: number) {
    void reverseLabel(lat, lon, `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`, "map");
  }

  function submitCoords() {
    const parsed = parseCoords(coordText);
    if (!parsed) {
      setCoordError("Couldn't read that. Try: 31.549, -97.147");
      return;
    }
    setCoordError(null);
    void reverseLabel(
      Number(parsed.lat.toFixed(5)),
      Number(parsed.lon.toFixed(5)),
      `${parsed.lat.toFixed(3)}°, ${parsed.lon.toFixed(3)}°`,
      "coords"
    );
  }

  /** Device GPS. The browser prompts for permission on first use. */
  function useMyLocation() {
    setGeoError(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError("This browser can't share a location.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const lat = Number(pos.coords.latitude.toFixed(5));
        const lon = Number(pos.coords.longitude.toFixed(5));
        void reverseLabel(lat, lon, `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`, "gps");
      },
      (err) => {
        setLocating(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission was denied. Use the map or type coordinates instead."
            : "Couldn't get a location fix. Use the map or type coordinates instead."
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  return (
    <div>
      {/*
        No "Find your field by" label above the buttons. The card is already
        headed "Your location" and the buttons say "Town or city" and
        "Coordinates" — a third line saying the same thing a third time cost a
        whole row of the card's height for nothing. `align-items: flex-end`
        keeps this row level with the crop select, which does still need a label
        because "Corn / sorghum" alone would not say what it selects.
      */}
      <div
        className="controls loc-controls"
        style={{ marginBottom: 10, gap: 8, alignItems: "flex-end" }}
      >
        <div className="field">
          <div className="seg">
            {/*
              "Town or city", not "Address".

              A user typed their station's street address, got nothing, and was
              told to use a city instead. Rural street addresses frequently are
              not in OpenStreetMap, so the old label promised something the
              geocoder cannot deliver outside towns. The capability still works
              where the address exists — it is the PROMISE that was wrong, and a
              tool that fails at what it advertises loses trust for the parts
              that do work.
            */}
            <button aria-pressed={mode === "search"} onClick={() => setMode("search")}>
              Town or city
            </button>
            <button aria-pressed={mode === "coords"} onClick={() => setMode("coords")}>
              Coordinates
            </button>
          </div>
        </div>
        <div className="field">
          <button onClick={useMyLocation} disabled={locating}>
            {locating ? "Locating…" : "📍 Use my location"}
          </button>
        </div>

        {/*
          Crop sits at the END of this row, right-aligned, because it is the one
          setting here that is not about WHERE — everything left of it locates
          the field, this one says which crop the heat units belong to. Keeping
          it in the same row keeps the card to one band of controls; the auto
          margin pushes it clear of the location group so the two do not read as
          one set.
        */}
        {gddPresets && onGddPresetChange && (
          <div className="field" style={{ marginLeft: "auto", alignItems: "flex-end" }}>
            <label htmlFor="loc-gdd-crop">Growing degree days for</label>
            <select
              id="loc-gdd-crop"
              value={gddPresetKey}
              onChange={(e) => onGddPresetChange(e.target.value)}
            >
              {Object.entries(gddPresets).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {mode === "search" ? (
        <div className="search-wrap" ref={boxRef} style={{ marginBottom: 10 }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
            style={{ display: "flex", gap: 6 }}
          >
            <input
              type="text"
              aria-label="Town or city, and state"
              placeholder="Town and state — e.g. Temple, TX"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearched(false);
              }}
              onFocus={() => (hits.length || searched) && setOpen(true)}
              style={{ flex: 1, minWidth: 0 }}
              autoComplete="off"
            />
            <button type="submit" disabled={query.trim().length < 3 || searching}>
              {searching ? "…" : "Search"}
            </button>
          </form>
          {open && searched && (
            <div className="search-results" role="listbox">
              {hits.length > 0 ? (
                hits.map((h, i) => (
                  <button key={`${h.lat}-${h.lon}-${i}`} onClick={() => choose(h)} role="option">
                    {h.label}
                    <span className="muted small" style={{ display: "block" }}>
                      {h.lat.toFixed(4)}°, {h.lon.toFixed(4)}°
                    </span>
                  </button>
                ))
              ) : (
                <div className="small muted" style={{ padding: "10px 12px" }}>
                  No matches. Search works on <strong>towns and cities</strong> — a rural street
                  address usually isn&apos;t on the map. Try the nearest town and state (e.g.
                  Temple, TX), then <strong>click the map</strong> to move the pin onto your field.
                  Coordinates work too, if you have them.
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginBottom: 10 }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitCoords();
            }}
            style={{ display: "flex", gap: 6 }}
          >
            <input
              type="text"
              aria-label="Latitude and longitude"
              placeholder="31.549, -97.147"
              value={coordText}
              onChange={(e) => setCoordText(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
              autoComplete="off"
            />
            <button type="submit">Go</button>
          </form>
          <div className="small muted" style={{ marginTop: 4 }}>
            {coordError ? (
              <span style={{ color: "var(--critical)" }}>{coordError}</span>
            ) : (
              <>
                Decimal, degrees/minutes/seconds, or degrees with decimal minutes all work — e.g.
                31.0982, −97.3428 or 31°5&apos;53&quot;N 97°20&apos;34&quot;W. UTM and State Plane are
                not supported.
              </>
            )}
          </div>
        </div>
      )}

      {geoError && (
        <div className="small" style={{ color: "var(--critical)", marginBottom: 8 }}>
          {geoError}
        </div>
      )}

      <MapCanvas
        lat={place.lat}
        lon={place.lon}
        center={TEXAS_CENTER}
        onPick={handleMapPick}
        cellSize={cellSize}
      />
    </div>
  );
}
