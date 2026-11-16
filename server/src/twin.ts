import type { Position } from "geojson";
import type { LocalFrame } from "./geo.ts";
import type { OsmRoad } from "./osm.ts";

const SAMPLE_M = 4;
const ON_ROAD_M = 1.5;
const MIN_GAP_M = 3;
export const MAX_GAP_M = 45;
const MIN_OPPOSITE_COS = 0.85;
const MAX_ALONG_COS = 0.5;
const MIN_PAIRED_SHARE = 0.5;
const BETWEEN_CHECKS = [0.25, 0.5, 0.75];
const DIVIDED_CLASSES = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
  "unclassified", "residential",
]);

type Vec = [number, number];
export type Blocked = (p: Vec) => boolean;

interface Carriageway {
  points: Vec[];
  forward: 1 | -1;
}

export interface Midline {
  lines: Vec[][];
  partners: Vec[][];
  gap: number;
}

const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (a: Vec, b: Vec): Vec => {
  const length = dist(a, b) || 1;
  return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
};
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];

function onewayDirection(road: OsmRoad): 1 | -1 | null {
  const value = String(road.tags.oneway ?? "");
  if (value === "1" || value === "yes" || value === "true") return 1;
  if (value === "-1") return -1;
  return null;
}

export function carriageways(roads: OsmRoad[], highway: unknown, frame: LocalFrame): Carriageway[] {
  return roads.flatMap((road) => {
    const forward = onewayDirection(road);
    if (forward === null || road.tags.highway !== highway || !DIVIDED_CLASSES.has(String(highway))) return [];
    return [{ points: road.line.coordinates.map((p) => frame.toLocal(p)), forward }];
  });
}

interface Hit {
  way: Carriageway;
  point: Vec;
  travel: Vec;
  distance: number;
}

function nearestOn(p: Vec, ways: Carriageway[], accept: (hit: Hit) => boolean): Hit | null {
  let best: Hit | null = null;
  for (const way of ways) {
    for (let i = 1; i < way.points.length; i++) {
      const [a, b] = [way.points[i - 1], way.points[i]];
      const along = unit(a, b);
      const t = Math.max(0, Math.min(dist(a, b), dot([p[0] - a[0], p[1] - a[1]], along)));
      const point: Vec = [a[0] + along[0] * t, a[1] + along[1] * t];
      const hit = { way, point, travel: [along[0] * way.forward, along[1] * way.forward] as Vec, distance: dist(p, point) };
      if ((!best || hit.distance < best.distance) && accept(hit)) best = hit;
    }
  }
  return best;
}

function oppositeOf(p: Vec, ways: Carriageway[], blocked: Blocked): Hit | null {
  const own = nearestOn(p, ways, (hit) => hit.distance <= ON_ROAD_M);
  if (!own) return null;
  return nearestOn(p, ways, (hit) => {
    if (hit.way === own.way || hit.distance < MIN_GAP_M || hit.distance > MAX_GAP_M) return false;
    if (dot(hit.travel, own.travel) > -MIN_OPPOSITE_COS) return false;
    if (Math.abs(dot(unit(p, hit.point), own.travel)) > MAX_ALONG_COS) return false;
    return !BETWEEN_CHECKS.some((t) => blocked([p[0] + (hit.point[0] - p[0]) * t, p[1] + (hit.point[1] - p[1]) * t]));
  });
}

function samples(line: Vec[]): Vec[] {
  const out: Vec[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const steps = Math.max(1, Math.ceil(dist(a, b) / SAMPLE_M));
    for (let s = 1; s <= steps; s++) out.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function midline(lines: Vec[][], ways: Carriageway[], blocked: Blocked = () => false): Midline | null {
  const gaps: number[] = [];
  let total = 0;
  const partners: Vec[][] = [];
  const mid = lines.map((line) => {
    let run: Vec[] = [];
    const points = samples(line).map((p): Vec => {
      total++;
      const opposite = oppositeOf(p, ways, blocked);
      if (!opposite) {
        if (run.length >= 2) partners.push(run);
        run = [];
        return p;
      }
      gaps.push(opposite.distance);
      run.push(opposite.point);
      return [(p[0] + opposite.point[0]) / 2, (p[1] + opposite.point[1]) / 2];
    });
    if (run.length >= 2) partners.push(run);
    return points;
  });
  if (total === 0 || gaps.length / total < MIN_PAIRED_SHARE) return null;
  return { lines: mid, partners, gap: median(gaps) };
}

export const toLngLat = (frame: LocalFrame) => (lines: Vec[][]): Position[][] => lines.map((l) => l.map((p) => frame.toLngLat(p)));
