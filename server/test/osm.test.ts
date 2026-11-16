import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";
import type { BBox } from "@map-wand/shared";
import { type OsmArea, type OsmData, type OsmRoad, type Tags, findHit, followStroke, roadWidth } from "../src/osm.ts";
import { at, line, rect } from "./fixtures.ts";

function roadOf(highway: string, ...points: [number, number][]): OsmRoad {
  const tags = { highway };
  return { line: line(...points), tags, width: roadWidth(tags) };
}

function areaOf(tags: Tags, x0: number, y0: number, x1: number, y1: number): OsmArea {
  const polygon = rect(x0, y0, x1, y1);
  return { polygon, bbox: turf.bbox(polygon) as BBox, tags, layer: tags.building ? "building" : "landcover", tile: "14/0/0" };
}

const VIEW = turf.bbox(turf.featureCollection([turf.point(at(-500, -500)), turf.point(at(500, 500))])) as BBox;

describe("followStroke", () => {
  const a = roadOf("residential", [0, 0], [100, 0]);
  const b = roadOf("residential", [100, 0], [200, 2]);
  const c = roadOf("residential", [200, 2], [300, 0]);
  const sideStreet = roadOf("residential", [100, 0], [100, 100]);
  const otherClass = roadOf("primary", [-100, 0], [0, 0]);

  it("continues straight through junctions and ignores turns and other road classes", () => {
    const stroke = followStroke(b, [a, b, c, sideStreet, otherClass]);
    expect(new Set(stroke)).toEqual(new Set([a, b, c]));
  });
});

describe("findHit", () => {
  const street = roadOf("residential", [-100, 0], [100, 0]);
  const building = areaOf({ building: "yes" }, -10, -2, 10, 20);
  const wood = areaOf({ natural: "wood" }, 30, 20, 60, 60);
  const data: OsmData = { areas: [building, wood], roads: [street] };

  it("prefers a building under the click", () => {
    expect(findHit(at(0, 1), data, VIEW, false)?.kind).toBe("building");
  });

  it("selects the whole road near the click", () => {
    const hit = findHit(at(50, 1), data, VIEW, false)!;
    expect(hit.kind).toBe("road");
    expect(hit.centerline?.type).toBe("MultiLineString");
    expect(turf.booleanPointInPolygon(turf.point(at(-90, 0)), hit.geometry)).toBe(true);
  });

  it("selects a small area when nothing else is there", () => {
    expect(findHit(at(45, 40), data, VIEW, false)?.label).toBe("natural: wood");
  });

  it("finds nothing on empty ground", () => {
    expect(findHit(at(0, 200), data, VIEW, false)).toBeNull();
  });
});
