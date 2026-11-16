import * as turf from "@turf/turf";
import type { MultiPolygon, Polygon, Position } from "geojson";
import type { BBox, EditResult, ExtendRequest, LassoRequest, MapContext, SelectRequest, WandFeature, WandProps, WandResult } from "@map-wand/shared";
import { CONFIG } from "./config.ts";
import { extendRoad } from "./extend.ts";
import { asPolygonal, polygonsOf } from "./geo.ts";
import { maskToPolygons, pickPolygon, simplifyPx } from "./mask.ts";
import { type OsmData, type OsmHit, areasTouching, findHit, loadOsm, roadsCrossing } from "./osm.ts";
import { SAM, type BoxPrompt, type Prediction } from "./sam.ts";
import { type Mosaic, buildMosaic, maxZoom, windowAround, windowForBounds } from "./tiles.ts";

const MAX_ROAD_SEARCH_DEG = 0.03;
const ROAD_SEARCH_RADIUS_DEG = 0.01;
const MIN_LASSO_CONTAINMENT = 0.5;
const MIN_LASSO_IOU = 0.1;
const MAX_LASSO_ALTERNATIVES = 6;
const GROUP_MEMBER_CONTAINMENT = 0.6;
const LASSO_BOUND_PADDING = 0.15;
const EXTEND_BOUND_PADDING = 0.5;
const EXTEND_MIN_PADDING_DEG = 0.002;

export function makeFeature(geometry: Polygon | MultiPolygon, props: Omit<WandProps, "area_m2">): WandFeature {
  return { type: "Feature", geometry, properties: { ...props, area_m2: Math.round(turf.area(geometry) * 10) / 10 } };
}

function fromHit(hit: OsmHit): WandFeature {
  return makeFeature(hit.geometry, {
    source: "osm",
    kind: hit.kind,
    label: hit.label,
    osm_tags: hit.tags,
    ...(hit.centerline ? { centerline: hit.centerline, width_m: hit.width } : {}),
    ...(hit.divided ? { divided: true } : {}),
  });
}

function tileZoom(ctx: MapContext): number {
  return Math.min(Math.round(ctx.zoom) + 1, maxZoom(ctx.layer));
}

function searchBound(point: Position, view: BBox): BBox {
  const [w, s, e, n] = view;
  if (e - w <= MAX_ROAD_SEARCH_DEG && n - s <= MAX_ROAD_SEARCH_DEG) return view;
  const r = ROAD_SEARCH_RADIUS_DEG;
  return [Math.max(w, point[0] - r), Math.max(s, point[1] - r), Math.min(e, point[0] + r), Math.min(n, point[1] + r)];
}

async function tryOsm(center: Position, bound: BBox, messages: string[]): Promise<OsmData | null> {
  try {
    return await loadOsm(center, bound);
  } catch (ex) {
    messages.push(`OSM unavailable (${(ex as Error).message}).`);
    return null;
  }
}

function predictionToGeometry(
  prediction: Prediction,
  mosaic: Mosaic,
  choose: (parts: Polygon[]) => Polygon[],
): Polygon | MultiPolygon | null {
  const parts = choose(maskToPolygons(prediction.mask))
    .map((p) => simplifyPx(p, CONFIG.wand.simplifyPx))
    .map((p) => ({ type: "Polygon" as const, coordinates: p.coordinates.map((ring) => ring.map((pt) => mosaic.toLngLat(pt))) }));
  return asPolygonal(parts);
}

async function samAtPoint(ctx: MapContext, point: Position): Promise<WandFeature[]> {
  const mosaic = await buildMosaic(ctx.layer, windowAround(point, tileZoom(ctx), CONFIG.wand.mosaicPx));
  const local = mosaic.toLocal(point);
  const predictions = await SAM.predict(mosaic, [[local[0], local[1], 1]]);
  return predictions.flatMap((prediction) => {
    const geometry = predictionToGeometry(prediction, mosaic, (parts) => {
      const picked = pickPolygon(parts, local);
      return picked ? [picked] : [];
    });
    return geometry
      ? [makeFeature(geometry, { source: "sam2", kind: "object", label: "object (SAM2)", score: round(prediction.score) })]
      : [];
  });
}

function round(value: number, digits = 3): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function samMessage(): string {
  return SAM.error ?? "SAM2 is still loading, try again in a moment.";
}

export async function select(req: SelectRequest): Promise<WandResult> {
  const started = Date.now();
  const messages: string[] = [];
  let alternatives: WandFeature[] = [];
  let selected = 0;

  if (req.strategy !== "sam") {
    const bound = searchBound(req.point, req.view_bbox);
    const data = await tryOsm(req.point, bound, messages);
    const hit = data && findHit(req.point, data, bound, req.strategy === "osm");
    if (hit) alternatives = [fromHit(hit)];
    else if (req.strategy === "osm") messages.push("No OSM object here.");
  }

  if (alternatives.length === 0 && req.strategy !== "osm") {
    if (!SAM.ready) messages.push(samMessage());
    else {
      const features = await samAtPoint(req, req.point);
      const best = features[0];
      alternatives = features.sort((a, b) => a.properties.area_m2 - b.properties.area_m2);
      selected = Math.max(0, alternatives.indexOf(best));
      if (!best) messages.push("SAM2 found nothing here.");
    }
  }

  return { anchor: req.point, alternatives, selected, messages, ms: Date.now() - started };
}

export interface LassoFit {
  iou: number;
  containment: number;
}

export function lassoFit(candidate: Polygon | MultiPolygon, lasso: Polygon): LassoFit {
  const inter = turf.intersect(turf.featureCollection([turf.feature(candidate), turf.feature(lasso)]));
  const interArea = inter ? turf.area(inter) : 0;
  const candidateArea = turf.area(candidate);
  const lassoArea = turf.area(lasso);
  return {
    iou: interArea / Math.max(candidateArea + lassoArea - interArea, 1e-9),
    containment: interArea / Math.max(candidateArea, 1e-9),
  };
}

export function rankByLasso(candidates: WandFeature[], lasso: Polygon): WandFeature[] {
  return candidates
    .map((feature) => ({ feature, fit: lassoFit(feature.geometry, lasso) }))
    .filter(({ fit }) => fit.containment >= MIN_LASSO_CONTAINMENT && fit.iou >= MIN_LASSO_IOU)
    .sort((a, b) => b.fit.iou - a.fit.iou)
    .slice(0, MAX_LASSO_ALTERNATIVES)
    .map(({ feature, fit }) => ({ ...feature, properties: { ...feature.properties, fit: round(fit.iou) } }));
}

export function buildingGroup(hits: OsmHit[], lasso: Polygon): WandFeature | null {
  const members = hits.filter((h) => h.kind === "building" && lassoFit(h.geometry, lasso).containment >= GROUP_MEMBER_CONTAINMENT);
  if (members.length < 2) return null;
  const merged = turf.union(turf.featureCollection(members.map((m) => turf.feature(m.geometry))));
  const geometry = asPolygonal(polygonsOf(merged?.geometry));
  return geometry && makeFeature(geometry, { source: "osm-group", kind: "building", label: `${members.length} buildings` });
}

function padded([w, s, e, n]: BBox, factor: number): BBox {
  const dx = (e - w) * factor;
  const dy = (n - s) * factor;
  return [w - dx, s - dy, e + dx, n + dy];
}

async function samInLasso(ctx: MapContext, lasso: Polygon): Promise<WandFeature[]> {
  const box = turf.bbox(lasso) as BBox;
  const mosaic = await buildMosaic(ctx.layer, windowForBounds(box, tileZoom(ctx), CONFIG.wand.mosaicPx));
  const [x1, y1] = mosaic.toLocal([box[0], box[3]]);
  const [x2, y2] = mosaic.toLocal([box[2], box[1]]);
  const inside = mosaic.toLocal(turf.pointOnFeature(lasso).geometry.coordinates);
  const prompt: BoxPrompt = [x1, y1, x2, y2];
  const localLasso: Polygon = { type: "Polygon", coordinates: lasso.coordinates.map((r) => r.map((p) => mosaic.toLocal(p))) };
  const predictions = await SAM.predict(mosaic, [[inside[0], inside[1], 1]], prompt);
  return predictions.flatMap((prediction) => {
    const geometry = predictionToGeometry(prediction, mosaic, (parts) =>
      parts.filter((part) => lassoFit(part, localLasso).containment >= MIN_LASSO_CONTAINMENT),
    );
    return geometry ? [makeFeature(geometry, { source: "sam2", kind: "object", label: "object (SAM2)" })] : [];
  });
}

function overlaps(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export async function extend(req: ExtendRequest): Promise<EditResult> {
  const messages: string[] = [];
  const [w, s, e, n] = turf.bbox(req.feature);
  const [x, y] = req.point;
  const reach: BBox = [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)];
  const [pw, ps, pe, pn] = padded(reach, EXTEND_BOUND_PADDING);
  const bound: BBox = [pw - EXTEND_MIN_PADDING_DEG, ps - EXTEND_MIN_PADDING_DEG, pe + EXTEND_MIN_PADDING_DEG, pn + EXTEND_MIN_PADDING_DEG];
  const data = await tryOsm(req.point, bound, messages);
  if (!data) return { feature: null, messages };
  const roads = data.roads.filter((road) => overlaps(turf.bbox(road.line) as BBox, bound));
  const outcome = extendRoad(req.feature, req.point, roads, CONFIG.osm.roadHitM);
  return "feature" in outcome ? { feature: outcome.feature, messages } : { feature: null, messages: [...messages, outcome.error] };
}

export async function lasso(req: LassoRequest): Promise<WandResult> {
  const started = Date.now();
  const messages: string[] = [];
  const shape = req.lasso;
  const candidates: WandFeature[] = [];

  if (req.strategy !== "sam") {
    const box = turf.bbox(shape) as BBox;
    const data = await tryOsm(turf.centroid(shape).geometry.coordinates, padded(box, LASSO_BOUND_PADDING), messages);
    if (data) {
      const areas = areasTouching(shape, data);
      candidates.push(...areas.map(fromHit), ...roadsCrossing(shape, data, box).map(fromHit));
      const group = buildingGroup(areas, shape);
      if (group) candidates.push(group);
    }
  }
  if (req.strategy !== "osm") {
    if (SAM.ready) candidates.push(...(await samInLasso(req, shape)));
    else messages.push(samMessage());
  }

  const alternatives = rankByLasso(candidates, shape);
  if (alternatives.length === 0) messages.push("Nothing found that fits the lasso.");
  const anchor = alternatives[0] ? turf.pointOnFeature(alternatives[0]).geometry.coordinates : null;
  return { anchor, alternatives, selected: 0, messages, ms: Date.now() - started };
}
