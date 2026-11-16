import { describe, expect, it } from "vitest";
import type { BBox, WandFeature } from "@map-wand/shared";
import { coverRoad } from "../src/cover.ts";
import { extendRoad } from "../src/extend.ts";
import { type OsmArea, type OsmRoad, dividedRoadPolygon } from "../src/osm.ts";
import { makeFeature } from "../src/wand.ts";
import { at, inside, line, rect } from "./fixtures.ts";

const WIDTH = 9;
const HIT_M = 6;

const way = (oneway: number | undefined, ...points: [number, number][]): OsmRoad => ({
  line: line(...points),
  tags: { highway: "secondary", ...(oneway === undefined ? {} : { oneway }) },
  width: WIDTH,
});

const box = (x0: number, y0: number, x1: number, y1: number): BBox => [...at(x0, y0), ...at(x1, y1)] as BBox;
const VIEW = box(-100, -60, 100, 60);

const data = (roads: OsmRoad[], areas: OsmArea[] = []) => ({ roads, areas });
const building = (x0: number, y0: number, x1: number, y1: number): OsmArea => ({
  polygon: rect(x0, y0, x1, y1), bbox: box(x0, y0, x1, y1), tags: { building: "yes" }, layer: "building", tile: "t",
});

const eastbound = way(1, [-100, -8], [100, -8]);
const westbound = way(1, [100, 8], [-100, 8]);

function selectDivided(roads: OsmRoad[]): WandFeature {
  const shaped = dividedRoadPolygon([eastbound], data(roads), VIEW);
  if (!shaped) throw new Error("not divided");
  return makeFeature(shaped.polygon, {
    source: "osm", kind: "road", label: "road", osm_tags: eastbound.tags,
    centerline: shaped.centerline, width_m: shaped.width, divided: true,
  });
}

describe("divided roads", () => {
  it("selects both carriageways and the median between them", () => {
    const shaped = dividedRoadPolygon([eastbound], data([eastbound, westbound]), VIEW)!;
    expect(shaped.divided).toBe(true);
    expect(shaped.width).toBeCloseTo(16 + WIDTH, 0);
    const feature = selectDivided([eastbound, westbound]);
    expect(inside(feature, 0, -8)).toBe(true);
    expect(inside(feature, 0, 0)).toBe(true);
    expect(inside(feature, 0, 8)).toBe(true);
    expect(inside(feature, 0, 15)).toBe(false);
  });

  it("does not pair a two-way road", () => {
    expect(dividedRoadPolygon([way(undefined, [-100, -8], [100, -8])], data([westbound]), VIEW)).toBeNull();
  });

  it("does not pair one-way streets going the same way", () => {
    const sameWay = way(1, [-100, 8], [100, 8]);
    expect(dividedRoadPolygon([eastbound], data([eastbound, sameWay]), VIEW)).toBeNull();
  });

  it("does not pair a parallel street a block away", () => {
    const farAway = way(1, [100, 52], [-100, 52]);
    expect(dividedRoadPolygon([eastbound], data([eastbound, farAway]), VIEW)).toBeNull();
  });

  it("does not pair service lanes", () => {
    const service = (...points: [number, number][]): OsmRoad => ({ ...way(1, ...points), tags: { highway: "service", oneway: 1 } });
    const [a, b] = [service([-100, -8], [100, -8]), service([100, 8], [-100, 8])];
    expect(dividedRoadPolygon([a], data([a, b]), VIEW)).toBeNull();
  });

  it("does not pair opposite one-way streets with buildings between them", () => {
    const nextStreet = way(1, [100, 30], [-100, 30]);
    const block = [-80, -40, 0, 40].map((x) => building(x, 0, x + 30, 22));
    expect(dividedRoadPolygon([eastbound], data([eastbound, nextStreet]), VIEW)).not.toBeNull();
    expect(dividedRoadPolygon([eastbound], data([eastbound, nextStreet], block), VIEW)).toBeNull();
  });

  it("puts the sides outside both carriageways", () => {
    const outcome = coverRoad(selectDivided([eastbound, westbound]), { road: false, sides: "both", side_m: 6 });
    if (!("feature" in outcome)) throw new Error(outcome.error);
    expect(inside(outcome.feature, 0, 15)).toBe(true);
    expect(inside(outcome.feature, 0, -15)).toBe(true);
    expect(inside(outcome.feature, 0, 8)).toBe(false);
    expect(inside(outcome.feature, 0, 0)).toBe(false);
  });

  it("extends along both carriageways", () => {
    const roads = [way(1, [-300, -8], [300, -8]), way(1, [300, 8], [-300, 8])];
    const outcome = extendRoad(selectDivided([eastbound, westbound]), at(200, -8), roads, HIT_M);
    if (!("feature" in outcome)) throw new Error(outcome.error);
    expect(inside(outcome.feature, 180, -8)).toBe(true);
    expect(inside(outcome.feature, 180, 0)).toBe(true);
    expect(inside(outcome.feature, 180, 8)).toBe(true);
    expect(inside(outcome.feature, 180, 16)).toBe(false);
  });
});
