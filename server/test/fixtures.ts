import * as turf from "@turf/turf";
import type { LineString, Polygon, Position } from "geojson";
import type { WandFeature } from "@map-wand/shared";
import { localFrame } from "../src/geo.ts";
import { makeFeature } from "../src/wand.ts";

export const ORIGIN: Position = [34.78, 32.08];
export const frame = localFrame(ORIGIN);
export const at = (x: number, y: number): Position => frame.toLngLat([x, y]);

export function line(...points: [number, number][]): LineString {
  return { type: "LineString", coordinates: points.map(([x, y]) => at(x, y)) };
}

export function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return { type: "Polygon", coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] };
}

export function road(centerline: LineString, width: number): WandFeature {
  const polygon = turf.buffer(centerline, width / 2, { units: "meters" })!.geometry as Polygon;
  return makeFeature(polygon, { source: "osm", kind: "road", label: "road", centerline, width_m: width });
}

export function inside(feature: WandFeature, x: number, y: number): boolean {
  return turf.booleanPointInPolygon(turf.point(at(x, y)), feature.geometry);
}
