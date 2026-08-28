"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Place } from "@/lib/types";
import { TEXAS_CENTER } from "@/lib/geo";

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
  onChange: (p: Place) => void;
  /** Grid cell of the active source, drawn on the map. Null for stations. */
  cellSize?: { lat: number; lon: number } | null;
}

interface SearchHit {
  label: string;
  lat: number;
  lon: number;
  county?: string;
}

/**
 * Accepts the coordinate formats people actually paste:
 *   31.549, -97.147
 *   31.549 -97.147
 *   31°32'56"N 97°08'49"W
 *   31.549N, 97.147W
 */
function parseCoords(input: string): { lat: number; lon: number } | null {
  const s = input.trim();
  if (!s) return null;

  // Degrees/minutes/seconds with hemisphere letters.
  const dms = [
    ...s.matchAll(
      /(\d{1,3})\s*[°d]\s*(\d{1,2})?\s*['′m]?\s*([\d.]+)?\s*["″s]?\s*([NSEWnsew])/g
    ),
  ];
  if (dms.length >= 2) {
    const vals = dms.slice(0, 2).map((m) => {
      const deg = Number(m[1]);
      const min = m[2] ? Number(m[2]) : 0;
      const sec = m[3] ? Number(m[3]) : 0;
      const hemi = m[4].toUpperCase();
      const v = deg + min / 60 + sec / 3600;
      return { v: hemi === "S" || hemi === "W" ? -v : v, axis: hemi };
    });
    const latPart = vals.find((v) => v.axis === "N" || v.axis === "S");
    const lonPart = vals.find((v) => v.axis === "E" || v.axis === "W");
    if (latPart && lonPart) return { lat: latPart.v, lon: lonPart.v };
  }

  // Decimal degrees, optionally with trailing hemisphere letters.
  const dec = [...s.matchAll(/(-?\d+(?:\.\d+)?)\s*°?\s*([NSEWnsew])?/g)]
    .map((m) => ({ v: Number(m[1]), hemi: m[2]?.toUpperCase() }))
    .filter((x) => Number.isFinite(x.v));

  if (dec.length >= 2) {
    let lat = dec[0].v;
    let lon = dec[1].v;
    if (dec[0].hemi === "S") lat = -Math.abs(lat);
    if (dec[0].hemi === "N") lat = Math.abs(lat);
    if (dec[1].hemi === "W") lon = -Math.abs(lon);
    if (dec[1].hemi === "E") lon = Math.abs(lon);
    // Texas longitudes are negative; a bare positive value is almost certainly
    // a dropped minus sign rather than a location in the Indian Ocean.
    if (!dec[1].hemi && lon > 0 && lon < 180 && lat > 0) lon = -lon;
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }

  return null;
}

export default function LocationPicker({ place, onChange, cellSize = null }: Props) {
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
    onChange({ lat: h.lat, lon: h.lon, label: h.label, county: h.county });
    setQuery("");
    setHits([]);
    setOpen(false);
  }

  async function reverseLabel(lat: number, lon: number, fallback: string) {
    onChange({ lat, lon, label: fallback });
    try {
      const res = await fetch(`/api/geocode?lat=${lat}&lon=${lon}`);
      const json = await res.json();
      const hit = json.results?.[0];
      if (hit?.label) onChange({ lat, lon, label: hit.label, county: hit.county });
    } catch {
      /* keep the coordinate label */
    }
  }

  function handleMapPick(lat: number, lon: number) {
    void reverseLabel(lat, lon, `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`);
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
      `${parsed.lat.toFixed(3)}°, ${parsed.lon.toFixed(3)}°`
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
        void reverseLabel(lat, lon, `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`);
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
      <div className="controls" style={{ marginBottom: 10, gap: 8 }}>
        <div className="field">
          <label>Find your field by</label>
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
          <label>&nbsp;</label>
          <button onClick={useMyLocation} disabled={locating}>
            {locating ? "Locating…" : "📍 Use my location"}
          </button>
        </div>
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
              placeholder="Town and state — e.g. Beeville, TX"
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
                  Beeville, TX), then <strong>click the map</strong> to move the pin onto your
                  field. Coordinates work too, if you have them.
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
              <>Decimal or degrees/minutes/seconds both work, e.g. 31°32&apos;56&quot;N 97°08&apos;49&quot;W</>
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
