import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LayerId } from "@map-wand/shared";

export interface LayerConfig {
  name: string;
  url: string;
  max_zoom: number;
  attribution: string;
}

export interface Config {
  port: number;
  cacheDir: string;
  userAgent: string;
  map: { center: [number, number]; zoom: number };
  layers: Record<LayerId, LayerConfig>;
  osm: {
    vectorTilesUrl: string;
    vectorTileZoom: number;
    buildingSearchM: number;
    roadHitM: number;
    smallAreaM2: number;
  };
  sam: { enabled: boolean; model: string; dtype: string };
  wand: { mosaicPx: number; simplifyPx: number };
}

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.MAP_WAND_CONFIG ?? resolve(SERVER_ROOT, "config.json");

export const CONFIG: Config = JSON.parse(readFileSync(configPath, "utf8"));
export const CACHE_DIR = resolve(SERVER_ROOT, CONFIG.cacheDir);
