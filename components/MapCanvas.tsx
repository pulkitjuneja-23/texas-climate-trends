"use client";

import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Rectangle,
  AttributionControl,
  ZoomControl,
  useMapEvents,
  useMap,
} from "react-leaflet";
import { useEffect } from "react";
import type { LatLon } from "@/lib/types";

/**
 * Client-only map.
 *
 * Uses CircleMarker rather than Marker on purpose — Leaflet's default marker
 * pulls PNG assets by relative URL, which breaks under bundlers.
 *
 * The default attribution control is replaced with `prefix={false}`. Leaflet
 * 1.9 ships a "Leaflet" credit with a flag glyph in its default prefix; the
 * OpenStreetMap credit is required by the tile licence, that prefix is not.
 */

interface Props {
  lat: number;
  lon: number;
  center: LatLon;
  onPick: (lat: number, lon: number) => void;
  /**
   * Grid cell size in degrees for the active source, drawn so the grower can
   * see the real resolution. Pass null for point/station sources.
   */
  cellSize?: { lat: number; lon: number } | null;
}

function ClickHandler({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(Number(e.latlng.lat.toFixed(4)), Number(e.latlng.lng.toFixed(4)));
    },
  });
  return null;
}

function Recenter({ lat, lon }: { lat: number; lon: number }) {
  const map = useMap();
  useEffect(() => {
    map.panTo([lat, lon], { animate: true });
  }, [lat, lon, map]);
  return null;
}

export default function MapCanvas({ lat, lon, center, onPick, cellSize = null }: Props) {
  const bounds: [[number, number], [number, number]] | null =
    cellSize && cellSize.lat > 0
      ? (() => {
          const y = Math.floor(lat / cellSize.lat) * cellSize.lat;
          const x = Math.floor(lon / cellSize.lon) * cellSize.lon;
          return [
            [y, x],
            [y + cellSize.lat, x + cellSize.lon],
          ];
        })()
      : null;

  return (
    <div className="map-shell">
      <MapContainer
        center={[center.lat, center.lon]}
        zoom={6}
        /*
          NO REPEATING WORLDS. Left to its defaults Leaflet lets you zoom out to
          level 0, where the whole world is 256 px wide, and fills the rest of
          the box with copies of it side by side — a reader saw several world
          maps stitched together and reasonably wondered what they were looking
          at. At zoom 4 the world is 4,096 px wide, wider than this map ever
          renders, so no copy can appear; it still shows the southern US and
          northern Mexico around Texas, which is all the orientation this tool
          needs.

          The bounds stop the view being dragged off into an ocean. They are
          deliberately wider than Texas, so a pin near the state line can still
          be seen in context; a click outside Texas is already answered by the
          "Data not available" panel rather than by refusing to pan there.
        */
        minZoom={4}
        maxBounds={[
          [14, -125],
          [50, -70],
        ]}
        maxBoundsViscosity={1.0}
        worldCopyJump={false}
        scrollWheelZoom
        attributionControl={false}
        // Default zoom buttons sit top-left, where they collide with the page
        // header when the map scrolls under the sticky bar. Moved bottom-right.
        zoomControl={false}
        style={{ height: "100%", width: "100%" }}
      >
        <ZoomControl position="bottomright" />
        <AttributionControl position="bottomleft" prefix={false} />
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={18}
          // Belt and braces with minZoom above: never draw a tile from a
          // second copy of the world.
          noWrap
        />
        {bounds && (
          <Rectangle
            bounds={bounds}
            pathOptions={{
              color: "#eb6834",
              weight: 1.5,
              dashArray: "5 4",
              fillOpacity: 0.06,
              fillColor: "#eb6834",
            }}
          />
        )}
        <CircleMarker
          center={[lat, lon]}
          radius={7}
          pathOptions={{
            color: "#ffffff",
            weight: 2,
            fillColor: "#2a78d6",
            fillOpacity: 1,
          }}
        />
        <ClickHandler onPick={onPick} />
        <Recenter lat={lat} lon={lon} />
      </MapContainer>
    </div>
  );
}
