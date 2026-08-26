/**
 * Constants that BOTH the browser and the server need.
 *
 * This file exists to keep a wall between them. The page is a client component
 * and needs to know the default source id — but importing that from
 * `registry.ts` drags in every source module, and gridMET now reaches Earth
 * Engine, which reaches `node:fs`. Webpack traced that chain into the browser
 * bundle and the build failed outright:
 *
 *   node:fs/promises -> lib/sources/earthengine.ts -> gridmet.ts
 *                    -> registry.ts -> app/page.tsx
 *
 * Nothing server-only may ever be imported from here. Keep it to plain values.
 */

export const DEFAULT_SOURCE_ID = "nasapower";
