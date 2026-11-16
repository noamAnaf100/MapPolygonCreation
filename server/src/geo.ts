import type { Geometry, MultiPolygon, Polygon, Position } from "geojson";

export const TILE = 256;
const MAX_LAT = 85.05112878;
const METERS_PER_DEG_LAT = 110_540;
const METERS_PER_DEG_LNG_EQUATOR = 111_320;

export function lngLatToPx([lng, lat]: Position, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

export function pxToLngLat([x, y]: Position, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat];
}

export function metersPerPx(lat: number, z: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

export interface LocalFrame {
  toLocal(p: Position): [number, number];
  toLngLat(p: Position): [number, number];
}

export function localFrame([lng0, lat0]: Position): LocalFrame {
  const kx = METERS_PER_DEG_LNG_EQUATOR * Math.cos((lat0 * Math.PI) / 180);
  const ky = METERS_PER_DEG_LAT;
  return {
    toLocal: ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky],
    toLngLat: ([x, y]) => [lng0 + x / kx, lat0 + y / ky],
  };
}

export function mapPositions<G extends Geometry>(geometry: G, fn: (p: Position) => Position): G {
  const walk = (c: unknown): unknown =>
    typeof (c as number[])[0] === "number" ? fn(c as Position) : (c as unknown[]).map(walk);
  if (geometry.type === "GeometryCollection") {
    return { ...geometry, geometries: geometry.geometries.map((g) => mapPositions(g, fn)) };
  }
  return { ...geometry, coordinates: walk((geometry as Exclude<Geometry, { type: "GeometryCollection" }>).coordinates) } as G;
}

export function polygonsOf(geometry: Geometry | null | undefined): Polygon[] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(polygonsOf);
  return [];
}

export function asPolygonal(polygons: Polygon[]): Polygon | MultiPolygon | null {
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return polygons[0];
  return { type: "MultiPolygon", coordinates: polygons.map((p) => p.coordinates) };
}

export function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(sum) / 2;
}
