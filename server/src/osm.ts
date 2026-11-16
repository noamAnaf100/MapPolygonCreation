import { join } from "node:path";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import * as turf from "@turf/turf";
import type { Feature, LineString, MultiLineString, MultiPolygon, Polygon, Position } from "geojson";
import type { BBox } from "@map-wand/shared";
import { CACHE_DIR, CONFIG } from "./config.ts";
import { TILE, asPolygonal, lngLatToPx, localFrame, polygonsOf, pxToLngLat } from "./geo.ts";
import { cachedFetch } from "./tiles.ts";

export type Tags = Record<string, string | number | boolean>;

export interface OsmArea {
  polygon: Polygon;
  bbox: BBox;
  tags: Tags;
  layer: string;
  tile: string;
}

export interface OsmRoad {
  line: LineString;
  tags: Tags;
  width: number;
}

export interface OsmData {
  areas: OsmArea[];
  roads: OsmRoad[];
}

export interface OsmHit {
  kind: "building" | "road" | "area";
  geometry: Polygon | MultiPolygon;
  tags: Tags;
  label: string;
  centerline?: LineString | MultiLineString;
  width?: number;
}

const AREA_LAYERS = new Set(["building", "landuse", "landcover", "park", "water", "aeroway"]);
const TAG_KEY_BY_LAYER: Record<string, string> = { landcover: "natural", park: "leisure" };
const ROAD_WIDTH_M: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
  residential: 7, unclassified: 6, living_street: 5, service: 4, pedestrian: 4,
  track: 3, footway: 2, path: 2, cycleway: 2, steps: 2, bridleway: 2,
};
const DEFAULT_ROAD_WIDTH_M = 6;
const OMT_CLASS_TO_HIGHWAY: Record<string, string> = {
  minor: "residential", busway: "service", bus_guideway: "service", raceway: "service",
};
const MINOR_WAYS = new Set(["footway", "path", "cycleway", "steps", "pedestrian", "track", "bridleway"]);
const MINOR_WAY_PENALTY_M = 4;
const NON_ROAD = new Set(["rail", "transit", "ferry", "aerialway", "pier"]);
const IGNORED_AREA_CLASSES = new Set(["suburb", "neighbourhood", "quarter", "city_block", "residential"]);
const MAX_TILES_PER_SIDE = 3;
const STROKE_JOIN_TOLERANCE_M = 2;
const STROKE_MAX_TURN_DEG = 40;
const STROKE_MAX_STEPS = 100;
const DECODED_CACHE_SIZE = 64;

let tileTemplate: string | null = null;

async function vectorTileTemplate(): Promise<string> {
  const url = CONFIG.osm.vectorTilesUrl;
  if (url.includes("{z}")) return url;
  if (!tileTemplate) {
    const response = await fetch(url, { headers: { "User-Agent": CONFIG.userAgent } });
    if (!response.ok) throw new Error(`Vector TileJSON unavailable: ${response.status}`);
    tileTemplate = ((await response.json()) as { tiles: string[] }).tiles[0];
  }
  return tileTemplate;
}

const decoded = new Map<string, OsmData>();

function tileBounds(z: number, x: number, y: number): BBox {
  const [west, north] = pxToLngLat([x * TILE, y * TILE], z);
  const [east, south] = pxToLngLat([(x + 1) * TILE, (y + 1) * TILE], z);
  return [west, south, east, north];
}

function roadTags(props: Record<string, unknown>): Tags | null {
  const cls = String(props.class ?? "");
  if (NON_ROAD.has(cls) || cls.endsWith("_construction")) return null;
  let highway = cls === "path" && props.subclass ? String(props.subclass) : (OMT_CLASS_TO_HIGHWAY[cls] ?? cls);
  if (props.ramp === 1 && ["motorway", "trunk", "primary", "secondary", "tertiary"].includes(highway)) highway += "_link";
  const tags: Tags = { highway };
  for (const key of ["brunnel", "oneway", "surface", "name"]) {
    if (props[key] !== undefined) tags[key] = props[key] as string;
  }
  return tags;
}

function areaTags(layer: string, props: Record<string, unknown>): Tags {
  if (layer === "building") return { building: "yes" };
  const tags: Tags = { [TAG_KEY_BY_LAYER[layer] ?? layer]: String(props.class ?? "yes") };
  if (props.subclass) tags.subclass = String(props.subclass);
  return tags;
}

export function roadWidth(tags: Tags): number {
  return ROAD_WIDTH_M[String(tags.highway)] ?? DEFAULT_ROAD_WIDTH_M;
}

export function clipLines(line: LineString | MultiLineString, bounds: BBox): Position[][] {
  const clipped = turf.bboxClip(line, bounds).geometry as LineString | MultiLineString;
  const lines = clipped.type === "LineString" ? [clipped.coordinates] : clipped.coordinates;
  return lines.filter((c) => c.length >= 2);
}

export function decodeTile(data: Uint8Array, z: number, x: number, y: number): OsmData {
  const tile = new VectorTile(new PbfReader(data));
  const bounds = tileBounds(z, x, y);
  const tileKey = `${z}/${x}/${y}`;
  const result: OsmData = { areas: [], roads: [] };
  for (const [layerName, layer] of Object.entries(tile.layers)) {
    if (layerName !== "transportation" && !AREA_LAYERS.has(layerName)) continue;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const geojson = feature.toGeoJSON(x, y, z) as Feature;
      const props = feature.properties as Record<string, unknown>;
      const geometry = geojson.geometry;
      if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
        if (layerName !== "transportation") continue;
        const tags = roadTags(props);
        if (!tags) continue;
        for (const coordinates of clipLines(geometry, bounds)) {
          result.roads.push({ line: { type: "LineString", coordinates }, tags, width: roadWidth(tags) });
        }
      } else if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
        const tags = layerName === "transportation" ? roadTags(props) : areaTags(layerName, props);
        if (!tags) continue;
        for (const polygon of polygonsOf(geometry)) {
          result.areas.push({ polygon, bbox: turf.bbox(polygon) as BBox, tags, layer: layerName, tile: tileKey });
        }
      }
    }
  }
  return result;
}

async function loadTile(z: number, x: number, y: number): Promise<OsmData> {
  const key = `${z}/${x}/${y}`;
  const cached = decoded.get(key);
  if (cached) return cached;
  const template = await vectorTileTemplate();
  const url = template.replace("{z}", `${z}`).replace("{x}", `${x}`).replace("{y}", `${y}`);
  const data = await cachedFetch(url, join(CACHE_DIR, "vector", `${z}`, `${x}`, `${y}.pbf`));
  const result = decodeTile(data, z, x, y);
  decoded.set(key, result);
  if (decoded.size > DECODED_CACHE_SIZE) decoded.delete(decoded.keys().next().value!);
  return result;
}

export async function loadOsm(center: Position, bounds: BBox): Promise<OsmData> {
  const z = CONFIG.osm.vectorTileZoom;
  const [west, south, east, north] = bounds;
  let [x0, y0] = lngLatToPx([west, north], z).map((v) => Math.floor(v / TILE));
  let [x1, y1] = lngLatToPx([east, south], z).map((v) => Math.floor(v / TILE));
  if (x1 - x0 + 1 > MAX_TILES_PER_SIDE || y1 - y0 + 1 > MAX_TILES_PER_SIDE) {
    const [cx, cy] = lngLatToPx(center, z).map((v) => Math.floor(v / TILE));
    [x0, x1, y0, y1] = [cx - 1, cx + 1, cy - 1, cy + 1];
  }
  const jobs: Promise<OsmData>[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(loadTile(z, x, y));
  const tiles = await Promise.all(jobs);
  return { areas: tiles.flatMap((t) => t.areas), roads: tiles.flatMap((t) => t.roads) };
}

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function sameClass(a: OsmArea, b: OsmArea): boolean {
  return a.layer === b.layer && JSON.stringify(a.tags) === JSON.stringify(b.tags);
}

export function stitchAcrossTiles(area: OsmArea, all: OsmArea[]): Polygon | MultiPolygon {
  const pieces = all.filter(
    (o) => o.tile !== area.tile && sameClass(o, area) && bboxesOverlap(o.bbox, area.bbox) &&
      (turf.intersect(turf.featureCollection([turf.feature(o.polygon), turf.feature(area.polygon)])) !== null),
  );
  if (pieces.length === 0) return area.polygon;
  const merged = turf.union(turf.featureCollection([area.polygon, ...pieces.map((p) => p.polygon)].map((g) => turf.feature(g))));
  return asPolygonal(polygonsOf(merged?.geometry)) ?? area.polygon;
}

export function areaLabel(tags: Tags): string {
  if (tags.building) return "building";
  if (tags.highway) return `road: ${tags.highway}`;
  const [key, value] = Object.entries(tags)[0];
  return tags.subclass ? `${key}: ${tags.subclass}` : `${key}: ${value}`;
}

function isIgnoredArea(area: OsmArea): boolean {
  return !area.tags.building && Object.values(area.tags).some((v) => IGNORED_AREA_CLASSES.has(String(v)));
}

function toHit(area: OsmArea, all: OsmArea[]): OsmHit {
  return {
    kind: area.tags.building ? "building" : "area",
    geometry: stitchAcrossTiles(area, all),
    tags: area.tags,
    label: areaLabel(area.tags),
  };
}

export function areasContaining(point: Position, data: OsmData): { area: OsmArea; m2: number }[] {
  const pt = turf.point(point);
  return data.areas
    .filter((a) => !isIgnoredArea(a) && a.bbox[0] <= point[0] && point[0] <= a.bbox[2] && a.bbox[1] <= point[1] && point[1] <= a.bbox[3])
    .filter((a) => turf.booleanPointInPolygon(pt, a.polygon))
    .map((area) => ({ area, m2: turf.area(area.polygon) }))
    .sort((a, b) => a.m2 - b.m2);
}

export function nearestRoad(point: Position, roads: OsmRoad[]): OsmRoad | null {
  const pt = turf.point(point);
  let best: { score: number; road: OsmRoad } | null = null;
  for (const road of roads) {
    const gap = turf.pointToLineDistance(pt, road.line, { units: "meters" }) - road.width / 2;
    if (gap > CONFIG.osm.roadHitM) continue;
    const score = gap + (MINOR_WAYS.has(String(road.tags.highway)) ? MINOR_WAY_PENALTY_M : 0);
    if (!best || score < best.score) best = { score, road };
  }
  return best?.road ?? null;
}

function turnAngle(a: Position, b: Position): number {
  const deg = ((Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])) * 180) / Math.PI;
  return Math.abs(((deg + 540) % 360) - 180);
}

export function followStroke(start: OsmRoad, roads: OsmRoad[]): OsmRoad[] {
  const frame = localFrame(start.line.coordinates[0]);
  const candidates = roads.filter((r) => r.tags.highway === start.tags.highway);
  const local = new Map(candidates.map((r) => [r, r.line.coordinates.map(frame.toLocal)]));
  local.set(start, start.line.coordinates.map(frame.toLocal));
  const chosen = [start];
  const used = new Set([start]);
  for (const fromStart of [true, false]) {
    let current = start;
    let atStart = fromStart;
    for (let step = 0; step < STROKE_MAX_STEPS; step++) {
      const cs = local.get(current)!;
      const end = atStart ? cs[0] : cs[cs.length - 1];
      const prev = atStart ? cs[1] : cs[cs.length - 2];
      const heading = [end[0] - prev[0], end[1] - prev[1]];
      let best: { angle: number; road: OsmRoad; atStart: boolean } | null = null;
      for (const road of candidates) {
        if (used.has(road)) continue;
        const c = local.get(road)!;
        let next: Position;
        let nextAtStart: boolean;
        if (Math.hypot(c[0][0] - end[0], c[0][1] - end[1]) < STROKE_JOIN_TOLERANCE_M) {
          next = c[1];
          nextAtStart = false;
        } else if (Math.hypot(c[c.length - 1][0] - end[0], c[c.length - 1][1] - end[1]) < STROKE_JOIN_TOLERANCE_M) {
          next = c[c.length - 2];
          nextAtStart = true;
        } else continue;
        const angle = turnAngle(heading, [next[0] - end[0], next[1] - end[1]]);
        if (angle < STROKE_MAX_TURN_DEG && (!best || angle < best.angle)) best = { angle, road, atStart: nextAtStart };
      }
      if (!best) break;
      current = best.road;
      atStart = best.atStart;
      used.add(current);
      chosen.push(current);
    }
  }
  return chosen;
}

export function roadPolygon(stroke: OsmRoad[], bound: BBox): { polygon: Polygon | MultiPolygon; centerline: MultiLineString } | null {
  const lines = stroke.flatMap((r) => clipLines(r.line, bound));
  if (lines.length === 0) return null;
  const centerline: MultiLineString = { type: "MultiLineString", coordinates: lines };
  const buffered = turf.buffer(centerline, stroke[0].width / 2, { units: "meters" });
  const clipped = buffered && turf.intersect(turf.featureCollection([buffered, turf.bboxPolygon(bound)]));
  const polygon = asPolygonal(polygonsOf(clipped?.geometry));
  return polygon ? { polygon, centerline } : null;
}

function roadHit(road: OsmRoad, data: OsmData, bound: BBox): OsmHit | null {
  const shaped = roadPolygon(followStroke(road, data.roads), bound);
  if (!shaped) return null;
  return {
    kind: "road",
    geometry: shaped.polygon,
    tags: road.tags,
    label: areaLabel(road.tags),
    centerline: shaped.centerline,
    width: road.width,
  };
}

export function findHit(point: Position, data: OsmData, bound: BBox, allowLarge: boolean): OsmHit | null {
  const containing = areasContaining(point, data);
  const building = containing.find((c) => c.area.tags.building);
  if (building) return toHit(building.area, data.areas);
  const road = nearestRoad(point, data.roads);
  if (road) {
    const hit = roadHit(road, data, bound);
    if (hit) return hit;
  }
  const small = containing.find((c) => !c.area.tags.highway && c.m2 < CONFIG.osm.smallAreaM2);
  const highwayArea = containing.find((c) => c.area.tags.highway);
  const fallback = small ?? highwayArea ?? (allowLarge ? containing[0] : undefined);
  return fallback ? toHit(fallback.area, data.areas) : null;
}

export function areasTouching(lasso: Polygon, data: OsmData): OsmHit[] {
  const box = turf.bbox(lasso) as BBox;
  const lassoFeature = turf.feature(lasso);
  return data.areas
    .filter((a) => !isIgnoredArea(a) && bboxesOverlap(a.bbox, box))
    .filter((a) => turf.booleanIntersects(lassoFeature, turf.feature(a.polygon)))
    .map((a) => toHit(a, data.areas));
}

export function roadsCrossing(lasso: Polygon, data: OsmData, bound: BBox): OsmHit[] {
  const lassoFeature = turf.feature(lasso);
  const crossing = data.roads.filter((r) => turf.booleanIntersects(lassoFeature, turf.feature(r.line)));
  const seen = new Set<OsmRoad>();
  const hits: OsmHit[] = [];
  for (const road of crossing) {
    if (seen.has(road)) continue;
    const stroke = followStroke(road, data.roads);
    stroke.forEach((r) => seen.add(r));
    const shaped = roadPolygon(stroke, bound);
    if (shaped) {
      hits.push({ kind: "road", geometry: shaped.polygon, tags: road.tags, label: areaLabel(road.tags), centerline: shaped.centerline, width: road.width });
    }
  }
  return hits;
}
