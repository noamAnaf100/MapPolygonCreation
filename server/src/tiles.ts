import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { LayerId } from "@map-wand/shared";
import type { Position } from "geojson";
import { CACHE_DIR, CONFIG } from "./config.ts";
import { TILE, lngLatToPx, pxToLngLat } from "./geo.ts";

const MAX_PARALLEL_FETCHES = 8;

export async function cachedFetch(url: string, cachePath: string): Promise<Buffer> {
  try {
    return await readFile(cachePath);
  } catch {
    const response = await fetch(url, { headers: { "User-Agent": CONFIG.userAgent } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
    const data = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, data);
    return data;
  }
}

let active = 0;
const waiting: (() => void)[] = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL_FETCHES) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export function maxZoom(layer: LayerId): number {
  return CONFIG.layers[layer].max_zoom;
}

export function getTile(layer: LayerId, z: number, x: number, y: number): Promise<Buffer> {
  const url = CONFIG.layers[layer].url.replace("{z}", `${z}`).replace("{x}", `${x}`).replace("{y}", `${y}`);
  return limited(() => cachedFetch(url, join(CACHE_DIR, "tiles", layer, `${z}`, `${x}`, `${y}.img`)));
}

export interface Window {
  z: number;
  x0: number;
  y0: number;
  width: number;
  height: number;
}

export class Mosaic {
  constructor(
    readonly layer: LayerId,
    readonly window: Window,
    readonly rgb: Buffer,
  ) {}

  get key(): string {
    const { z, x0, y0, width, height } = this.window;
    return `${this.layer}/${z}/${x0}/${y0}/${width}x${height}`;
  }

  toLocal(p: Position): [number, number] {
    const [x, y] = lngLatToPx(p, this.window.z);
    return [x - this.window.x0, y - this.window.y0];
  }

  toLngLat([x, y]: Position): [number, number] {
    return pxToLngLat([x + this.window.x0, y + this.window.y0], this.window.z);
  }
}

export function windowAround(p: Position, z: number, size: number): Window {
  const [x, y] = lngLatToPx(p, z);
  const half = Math.floor(size / TILE / 2);
  return {
    z,
    x0: (Math.floor(x / TILE) - half) * TILE,
    y0: (Math.floor(y / TILE) - half) * TILE,
    width: size,
    height: size,
  };
}

export function windowForBounds([w, s, e, n]: number[], zMax: number, maxPx: number, padPx = 32): Window {
  for (let z = zMax; z > 0; z--) {
    const [x0, y0] = lngLatToPx([w, n], z);
    const [x1, y1] = lngLatToPx([e, s], z);
    const width = Math.ceil(x1 - x0 + 2 * padPx);
    const height = Math.ceil(y1 - y0 + 2 * padPx);
    if (width <= maxPx && height <= maxPx) {
      return { z, x0: Math.floor(x0 - padPx), y0: Math.floor(y0 - padPx), width, height };
    }
  }
  throw new Error("Area too large");
}

export async function buildMosaic(layer: LayerId, window: Window): Promise<Mosaic> {
  const { z, x0, y0, width, height } = window;
  const tx0 = Math.floor(x0 / TILE);
  const ty0 = Math.floor(y0 / TILE);
  const tx1 = Math.floor((x0 + width - 1) / TILE);
  const ty1 = Math.floor((y0 + height - 1) / TILE);
  const worldTiles = 2 ** z;
  const jobs: Promise<OverlayOptions | null>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (ty < 0 || ty >= worldTiles) continue;
      const wrappedX = ((tx % worldTiles) + worldTiles) % worldTiles;
      jobs.push(
        getTile(layer, z, wrappedX, ty)
          .then((input) => ({ input, left: (tx - tx0) * TILE, top: (ty - ty0) * TILE }))
          .catch(() => null),
      );
    }
  }
  const overlays = (await Promise.all(jobs)).filter((o): o is OverlayOptions => o !== null);
  const canvas = await sharp({
    create: { width: (tx1 - tx0 + 1) * TILE, height: (ty1 - ty0 + 1) * TILE, channels: 3, background: "#000" },
  })
    .composite(overlays)
    .png()
    .toBuffer();
  const rgb = await sharp(canvas)
    .extract({ left: x0 - tx0 * TILE, top: y0 - ty0 * TILE, width, height })
    .removeAlpha()
    .raw()
    .toBuffer();
  return new Mosaic(layer, window, rgb);
}
