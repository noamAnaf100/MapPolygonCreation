import * as turf from "@turf/turf";
import type { Feature, LineString, MultiLineString, Polygon, Position } from "geojson";
import type { RoadCover, WandFeature } from "@map-wand/shared";
import { asPolygonal, localFrame, polygonsOf } from "./geo.ts";

const SAMPLE_M = 1;
const BISECT_STEPS = 12;
const ARC_STEP_RAD = Math.PI / 12;
const CONNECT_M = 1.5;
const PARALLEL_DOT = 0.5;
const MIN_SIDE_M = 0.5;
const MAX_SIDE_M = 200;

type Vec = [number, number];

export type CoverOutcome = { feature: WandFeature; sideNames: [string, string] } | { error: string };

const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const unit = (a: Vec, b: Vec): Vec => {
  const length = dist(a, b) || 1;
  return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
};
const leftOf = ([x, y]: Vec): Vec => [-y, x];
const offset = (p: Vec, n: Vec, d: number): Vec => [p[0] + n[0] * d, p[1] + n[1] * d];

function linesOf(centerline: LineString | MultiLineString): Position[][] {
  return centerline.type === "LineString" ? [centerline.coordinates] : centerline.coordinates;
}

function crossing(outside: Vec, inside: Vec, isInside: (p: Vec) => boolean): Vec {
  let [lo, hi] = [outside, inside];
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = lerp(lo, hi, 0.5);
    if (isInside(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function clipToShape(line: Vec[], isInside: (p: Vec) => boolean): Vec[][] {
  const pieces: Vec[][] = [];
  let prev = line[0];
  let prevIn = isInside(prev);
  let piece: Vec[] = prevIn ? [prev] : [];
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const steps = Math.max(1, Math.ceil(dist(a, b) / SAMPLE_M));
    for (let s = 1; s <= steps; s++) {
      const p = lerp(a, b, s / steps);
      const pIn = isInside(p);
      if (pIn && !prevIn) piece = [crossing(prev, p, isInside)];
      if (!pIn && prevIn) {
        piece.push(crossing(p, prev, isInside));
        if (piece.length >= 2) pieces.push(piece);
        piece = [];
      }
      if (pIn && s === steps) piece.push(p);
      prev = p;
      prevIn = pIn;
    }
  }
  if (piece.length >= 2) pieces.push(piece);
  return pieces;
}

const length = (line: Vec[]) => line.slice(1).reduce((sum, p, i) => sum + dist(line[i], p), 0);

interface Nearest {
  distance: number;
  vertex: number;
  line: Vec[];
  segment: number;
  point: Vec;
}

function nearestBetween(piece: Vec[], oriented: Vec[][]): Nearest | null {
  let best: Nearest | null = null;
  piece.forEach((v, vertex) => {
    for (const line of oriented) {
      for (let segment = 1; segment < line.length; segment++) {
        const [a, b] = [line[segment - 1], line[segment]];
        const d = unit(a, b);
        const t = Math.max(0, Math.min(dist(a, b), (v[0] - a[0]) * d[0] + (v[1] - a[1]) * d[1]));
        const point = offset(a, d, t);
        const distance = dist(v, point);
        if (!best || distance < best.distance) best = { distance, vertex, line, segment, point };
      }
    }
  });
  return best;
}

function orientAlong(piece: Vec[], oriented: Vec[][]): Vec[] {
  const near = nearestBetween(piece, oriented);
  if (!near) return piece;
  const last = piece.length - 1;
  const atEnd = near.vertex === 0 || near.vertex === last;
  const reversed = [...piece].reverse();
  if (atEnd && dist(near.point, near.line[0]) < CONNECT_M) return near.vertex === last ? piece : reversed;
  if (atEnd && dist(near.point, near.line[near.line.length - 1]) < CONNECT_M) return near.vertex === 0 ? piece : reversed;
  const i = Math.min(near.vertex, last - 1);
  const pieceTangent = unit(piece[i], piece[i + 1]);
  const lineTangent = unit(near.line[near.segment - 1], near.line[near.segment]);
  const alignment = pieceTangent[0] * lineTangent[0] + pieceTangent[1] * lineTangent[1];
  if (Math.abs(alignment) >= PARALLEL_DOT) return alignment >= 0 ? piece : reversed;
  return near.vertex <= last / 2 ? piece : reversed;
}

function orient(pieces: Vec[][]): { lines: Vec[][]; sideNames: [string, string] } {
  const [first, ...rest] = [...pieces].sort((a, b) => length(b) - length(a));
  const [dx, dy] = [first[first.length - 1][0] - first[0][0], first[first.length - 1][1] - first[0][1]];
  const eastWest = Math.abs(dx) >= Math.abs(dy);
  const lines = [(eastWest ? dx : dy) >= 0 ? first : [...first].reverse()];
  const remaining = [...rest];
  while (remaining.length > 0) {
    const distances = remaining.map((p) => nearestBetween(p, lines)?.distance ?? Infinity);
    const next = distances.indexOf(Math.min(...distances));
    lines.push(orientAlong(remaining.splice(next, 1)[0], lines));
  }
  return { lines, sideNames: eastWest ? ["North", "South"] : ["West", "East"] };
}

function sector(center: Vec, from: Vec, to: Vec, near: number, far: number): Vec[] | null {
  const start = Math.atan2(from[1], from[0]);
  let sweep = Math.atan2(to[1], to[0]) - start;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  if (Math.abs(sweep) < 1e-6) return null;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP_RAD));
  const arc = (r: number) =>
    Array.from({ length: steps + 1 }, (_, k): Vec => {
      const a = start + (sweep * k) / steps;
      return [center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r];
    });
  const ring = [...arc(far), ...arc(near).reverse()];
  return [...ring, ring[0]];
}

function neighbourDirection(p: Vec, own: Vec[], lines: Vec[][], leaving: boolean): Vec | null {
  for (const line of lines) {
    if (line === own) continue;
    const last = line.length - 1;
    if (dist(line[0], p) < CONNECT_M) return leaving ? unit(line[0], line[1]) : unit(line[1], line[0]);
    if (dist(line[last], p) < CONNECT_M) return leaving ? unit(line[last], line[last - 1]) : unit(line[last - 1], line[last]);
  }
  return null;
}

function sideRings(line: Vec[], lines: Vec[][], sign: 1 | -1, near: number, far: number): Vec[][] {
  const sideOf = (direction: Vec): Vec => {
    const n = leftOf(direction);
    return [n[0] * sign, n[1] * sign];
  };
  const normals = line.slice(1).map((p, i) => sideOf(unit(line[i], p)));
  const rings: Vec[][] = normals.map((n, i) => {
    const [a, b] = [line[i], line[i + 1]];
    const quad = [offset(a, n, near), offset(b, n, near), offset(b, n, far), offset(a, n, far)];
    return [...quad, quad[0]];
  });
  for (let i = 1; i < line.length - 1; i++) {
    const ring = sector(line[i], normals[i - 1], normals[i], near, far);
    if (ring) rings.push(ring);
  }
  const last = line.length - 1;
  const arriving = neighbourDirection(line[0], line, lines, false);
  const leaving = neighbourDirection(line[last], line, lines, true);
  const joints = [
    arriving && sector(line[0], sideOf(arriving), normals[0], near, far),
    leaving && sector(line[last], normals[last - 1], sideOf(leaving), near, far),
  ];
  for (const ring of joints) if (ring) rings.push(ring);
  return rings;
}

export function coverRoad(feature: WandFeature, cover: RoadCover): CoverOutcome {
  const { centerline, width_m } = feature.properties;
  if (!centerline || !width_m) return { error: "Only roads have sides to cover." };
  if (!cover.road && cover.sides === "none") return { error: "Pick the road, a side, or both." };

  const frame = localFrame(turf.centroid(feature).geometry.coordinates);
  const shape = turf.feature(feature.geometry);
  const isInside = (p: Vec) => turf.booleanPointInPolygon(turf.point(frame.toLngLat(p)), shape);
  const pieces = linesOf(centerline).flatMap((line) => clipToShape(line.map(frame.toLocal), isInside));
  if (pieces.length === 0) return { error: "Could not find the selected part of the road." };
  const { lines, sideNames } = orient(pieces);

  const near = width_m / 2;
  const sideM = Math.min(MAX_SIDE_M, Math.max(MIN_SIDE_M, cover.side_m));
  const signs: (1 | -1)[] = { none: [], left: [1], right: [-1], both: [1, -1] }[cover.sides] as (1 | -1)[];
  const toPolygon = (ring: Vec[]): Feature<Polygon> => turf.polygon([ring.map(frame.toLngLat)]);
  const strips = signs.flatMap((sign) => lines.flatMap((line) => sideRings(line, lines, sign, near, near + sideM))).map(toPolygon);

  const parts: Feature<Polygon>[] = cover.road ? polygonsOf(feature.geometry).map((p) => turf.feature(p)) : [];
  let merged = parts.length + strips.length > 1 ? turf.union(turf.featureCollection([...parts, ...strips])) : (parts[0] ?? strips[0]);
  if (!cover.road && merged) merged = turf.difference(turf.featureCollection([merged, shape as Feature<Polygon>]));
  const geometry = asPolygonal(polygonsOf(merged?.geometry));
  if (!geometry) return { error: "Could not build the sides of this road." };

  const sideTags = signs.map((sign) => sideNames[sign === 1 ? 0 : 1].toLowerCase());
  return {
    sideNames,
    feature: {
      ...feature,
      geometry,
      properties: {
        ...feature.properties,
        area_m2: Math.round(turf.area(geometry) * 10) / 10,
        covers: [...(cover.road ? ["road"] : []), ...sideTags],
        ...(signs.length > 0 ? { side_m: sideM } : {}),
      },
    },
  };
}
