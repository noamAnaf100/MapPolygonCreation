import * as turf from "@turf/turf";
import type { LineString, MultiLineString, Position } from "geojson";
import type { WandFeature } from "@map-wand/shared";
import { type LocalFrame, asPolygonal, localFrame, polygonsOf } from "./geo.ts";
import type { OsmRoad } from "./osm.ts";

const NODE_MERGE_M = 1;
const JUNCTION_SNAP_M = 2.5;
const GRID_CELL_M = 25;
const CENTERLINE_SAMPLE_M = 2;
const OTHER_CLASS_COST_FACTOR = 3;
const MAX_EXTENSION_M = 3000;
const MAX_DETOUR_FACTOR = 2.5;
const DETOUR_SLACK_M = 50;

type Vec = [number, number];

interface Edge {
  to: number;
  cost: number;
}

interface Segment {
  a: number;
  b: number;
  width: number;
  factor: number;
}

interface Projection {
  segment: Segment;
  point: Vec;
  distance: number;
}

export type ExtendOutcome = { feature: WandFeature } | { error: string };

const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cellKey = (x: number, y: number) => `${x},${y}`;

function project(p: Vec, a: Vec, b: Vec): Vec {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return [a[0] + t * dx, a[1] + t * dy];
}

class RoadGraph {
  readonly points: Vec[] = [];
  readonly adjacency: Edge[][] = [];
  readonly segments: Segment[] = [];
  private readonly nodeGrid = new Map<string, number[]>();
  private readonly segmentGrid = new Map<string, Segment[]>();

  constructor(roads: { line: Vec[]; width: number; factor: number }[]) {
    for (const road of roads) {
      for (let i = 1; i < road.line.length; i++) {
        const a = this.node(road.line[i - 1]);
        const b = this.node(road.line[i]);
        if (a !== b) this.addSegment({ a, b, width: road.width, factor: road.factor });
      }
    }
    this.snapDeadEnds();
  }

  addNode(p: Vec): number {
    const id = this.points.push(p) - 1;
    this.adjacency.push([]);
    const key = cellKey(Math.floor(p[0] / NODE_MERGE_M), Math.floor(p[1] / NODE_MERGE_M));
    this.nodeGrid.set(key, [...(this.nodeGrid.get(key) ?? []), id]);
    return id;
  }

  link(a: number, b: number, length: number, factor: number): void {
    this.adjacency[a].push({ to: b, cost: length * factor });
    this.adjacency[b].push({ to: a, cost: length * factor });
  }

  nearest(p: Vec, radius: number, skip?: (s: Segment) => boolean): Projection | null {
    let best: Projection | null = null;
    for (const segment of this.segmentsNear(p, radius)) {
      if (skip?.(segment)) continue;
      const point = project(p, this.points[segment.a], this.points[segment.b]);
      const distance = dist(p, point);
      if (distance <= radius && (!best || distance < best.distance)) best = { segment, point, distance };
    }
    return best;
  }

  attach(p: Vec, at: Projection): number {
    const id = this.addNode(p);
    const { a, b, factor } = at.segment;
    this.link(id, a, dist(p, this.points[a]), factor);
    this.link(id, b, dist(p, this.points[b]), factor);
    return id;
  }

  private node(p: Vec): number {
    const cx = Math.floor(p[0] / NODE_MERGE_M);
    const cy = Math.floor(p[1] / NODE_MERGE_M);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const found = this.nodeGrid.get(cellKey(cx + dx, cy + dy))?.find((id) => dist(this.points[id], p) < NODE_MERGE_M);
        if (found !== undefined) return found;
      }
    }
    return this.addNode(p);
  }

  private addSegment(segment: Segment): void {
    this.segments.push(segment);
    this.link(segment.a, segment.b, dist(this.points[segment.a], this.points[segment.b]), segment.factor);
    const [a, b] = [this.points[segment.a], this.points[segment.b]];
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])].map((v) => Math.floor(v / GRID_CELL_M));
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])].map((v) => Math.floor(v / GRID_CELL_M));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) this.segmentGrid.set(cellKey(x, y), [...(this.segmentGrid.get(cellKey(x, y)) ?? []), segment]);
    }
  }

  private segmentsNear(p: Vec, radius: number): Set<Segment> {
    const found = new Set<Segment>();
    const [x0, x1] = [p[0] - radius, p[0] + radius].map((v) => Math.floor(v / GRID_CELL_M));
    const [y0, y1] = [p[1] - radius, p[1] + radius].map((v) => Math.floor(v / GRID_CELL_M));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) this.segmentGrid.get(cellKey(x, y))?.forEach((s) => found.add(s));
    }
    return found;
  }

  private snapDeadEnds(): void {
    const deadEnds = this.adjacency.flatMap((edges, id) => (edges.length === 1 ? [id] : []));
    for (const id of deadEnds) {
      const p = this.points[id];
      const at = this.nearest(p, JUNCTION_SNAP_M, (s) => s.a === id || s.b === id);
      if (!at) continue;
      const { a, b, factor } = at.segment;
      this.link(id, a, at.distance + dist(at.point, this.points[a]), factor);
      this.link(id, b, at.distance + dist(at.point, this.points[b]), factor);
    }
  }
}

class MinHeap {
  private readonly items: [number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: [number, number]): void {
    const items = this.items;
    items.push(item);
    for (let i = items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): [number, number] {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && items[l][0] < items[smallest][0]) smallest = l;
        if (r < items.length && items[r][0] < items[smallest][0]) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function shortestPath(graph: RoadGraph, from: number, to: number): number[] | null {
  const cost = new Map<number, number>([[from, 0]]);
  const previous = new Map<number, number>();
  const heap = new MinHeap();
  heap.push([0, from]);
  while (heap.size > 0) {
    const [c, node] = heap.pop();
    if (node === to) break;
    if (c > (cost.get(node) ?? Infinity)) continue;
    for (const edge of graph.adjacency[node]) {
      const next = c + edge.cost;
      if (next < (cost.get(edge.to) ?? Infinity)) {
        cost.set(edge.to, next);
        previous.set(edge.to, node);
        heap.push([next, edge.to]);
      }
    }
  }
  if (!cost.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(previous.get(path[0])!);
  return path;
}

function linesOf(centerline: LineString | MultiLineString): Position[][] {
  return centerline.type === "LineString" ? [centerline.coordinates] : centerline.coordinates;
}

function nearestSelectedPoint(feature: WandFeature, frame: LocalFrame, click: Vec): Vec | null {
  const selected = turf.feature(feature.geometry);
  let best: Vec | null = null;
  for (const line of linesOf(feature.properties.centerline!)) {
    const local = line.map(frame.toLocal);
    for (let i = 1; i < local.length; i++) {
      const [a, b] = [local[i - 1], local[i]];
      const steps = Math.max(1, Math.ceil(dist(a, b) / CENTERLINE_SAMPLE_M));
      for (let s = 0; s <= steps; s++) {
        const p: Vec = [a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps];
        if (best && dist(p, click) >= dist(best, click)) continue;
        if (turf.booleanPointInPolygon(turf.point(frame.toLngLat(p)), selected)) best = p;
      }
    }
  }
  return best;
}

function pathLength(points: Vec[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

export function extendRoad(feature: WandFeature, point: Position, roads: OsmRoad[], hitM: number): ExtendOutcome {
  const { centerline, width_m, osm_tags } = feature.properties;
  if (!centerline || !width_m) return { error: "Only roads can be extended." };

  const frame = localFrame(point);
  const click = frame.toLocal(point);
  const start = nearestSelectedPoint(feature, frame, click);
  if (!start) return { error: "Could not find the selected part of the road." };

  const graph = new RoadGraph(
    roads.map((road) => ({
      line: road.line.coordinates.map(frame.toLocal),
      width: road.width,
      factor: road.tags.highway === osm_tags?.highway ? 1 : OTHER_CLASS_COST_FACTOR,
    })),
  );

  const maxWidth = Math.max(width_m, ...roads.map((r) => r.width));
  const target = graph.nearest(click, hitM + maxWidth / 2);
  if (!target || target.distance > hitM + target.segment.width / 2) return { error: "No road here to extend to." };
  if (turf.booleanPointInPolygon(turf.point(frame.toLngLat(target.point)), feature.geometry)) {
    return { error: "That part of the road is already selected." };
  }
  const origin = graph.nearest(start, JUNCTION_SNAP_M);
  if (!origin) return { error: "The selected road is not in the map data around here." };

  const from = graph.attach(start, origin);
  const to = graph.attach(target.point, target);
  if (origin.segment === target.segment) graph.link(from, to, dist(start, target.point), origin.segment.factor);
  const path = shortestPath(graph, from, to);
  if (!path) return { error: "This road does not connect to the selection." };

  const points = path.map((id) => graph.points[id]);
  const length = pathLength(points);
  if (length > MAX_EXTENSION_M || length > dist(start, target.point) * MAX_DETOUR_FACTOR + DETOUR_SLACK_M) {
    return { error: "That point is not along this road." };
  }

  const extension: LineString = { type: "LineString", coordinates: points.map(frame.toLngLat) };
  const buffered = turf.buffer(extension, width_m / 2, { units: "meters" });
  const merged = buffered && turf.union(turf.featureCollection([turf.feature(feature.geometry), buffered]));
  const geometry = asPolygonal(polygonsOf(merged?.geometry));
  if (!geometry) return { error: "Could not extend the road here." };

  return {
    feature: {
      ...feature,
      geometry,
      properties: {
        ...feature.properties,
        area_m2: Math.round(turf.area(geometry) * 10) / 10,
        centerline: { type: "MultiLineString", coordinates: [...linesOf(centerline), extension.coordinates] },
        extensions: (feature.properties.extensions ?? 0) + 1,
      },
    },
  };
}
