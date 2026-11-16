import { describe, expect, it } from "vitest";
import type { MultiLineString, Position } from "geojson";
import type { RoadCover, WandFeature } from "@map-wand/shared";
import { type CoverOutcome, coverRoad } from "../src/cover.ts";
import { cutAt } from "../src/cut.ts";
import { at, inside, line, road } from "./fixtures.ts";

const WIDTH = 7;
const SIDE = 10;

const cover = (c: Partial<RoadCover>): RoadCover => ({ road: true, sides: "none", side_m: SIDE, ...c });

function covered(outcome: CoverOutcome): WandFeature {
  if (!("feature" in outcome)) throw new Error(outcome.error);
  return outcome.feature;
}

const straight = () => road(line([-50, 0], [50, 0]), WIDTH);

describe("coverRoad", () => {
  it("keeps the road as it is", () => {
    const result = covered(coverRoad(straight(), cover({})));
    expect(inside(result, 0, 0)).toBe(true);
    expect(inside(result, 0, 8)).toBe(false);
    expect(result.properties.covers).toEqual(["road"]);
  });

  it("covers one side only, named by compass", () => {
    const outcome = coverRoad(straight(), cover({ road: false, sides: "left" }));
    const result = covered(outcome);
    expect("sideNames" in outcome && outcome.sideNames).toEqual(["North", "South"]);
    expect(inside(result, 0, 8)).toBe(true);
    expect(inside(result, 48, 8)).toBe(true);
    expect(inside(result, 0, 0)).toBe(false);
    expect(inside(result, 0, -8)).toBe(false);
    expect(inside(result, 0, 16)).toBe(false);
    expect(inside(result, 56, 8)).toBe(false);
    expect(result.properties.covers).toEqual(["north"]);
    expect(result.properties.side_m).toBe(SIDE);
  });

  it("names sides the same whichever way the road was drawn", () => {
    const result = covered(coverRoad(road(line([50, 0], [-50, 0]), WIDTH), cover({ road: false, sides: "left" })));
    expect(inside(result, 0, 8)).toBe(true);
    expect(inside(result, 0, -8)).toBe(false);
  });

  it("covers the road and one side", () => {
    const result = covered(coverRoad(straight(), cover({ sides: "right" })));
    expect(inside(result, 0, 0)).toBe(true);
    expect(inside(result, 0, -8)).toBe(true);
    expect(inside(result, 0, 8)).toBe(false);
    expect(result.properties.covers).toEqual(["road", "south"]);
  });

  it("covers both sides without the road", () => {
    const result = covered(coverRoad(straight(), cover({ road: false, sides: "both", side_m: 4 })));
    expect(inside(result, 0, 5)).toBe(true);
    expect(inside(result, 0, -5)).toBe(true);
    expect(inside(result, 0, 0)).toBe(false);
    expect(inside(result, 0, 9)).toBe(false);
    expect(result.geometry.type).toBe("MultiPolygon");
  });

  it("stops the sides where the road was cut", () => {
    const cut = cutAt(straight(), at(-40, 0), at(20, 0))!;
    const result = covered(coverRoad(cut, cover({ road: false, sides: "left" })));
    expect(inside(result, 10, 8)).toBe(true);
    expect(inside(result, 30, 8)).toBe(false);
  });

  it("fills the outside of a bend", () => {
    const result = covered(coverRoad(road(line([-50, 0], [0, 0], [0, 50]), WIDTH), cover({ road: false, sides: "both" })));
    expect(inside(result, 7, -7)).toBe(true);
    expect(inside(result, -8, 20)).toBe(true);
  });

  it("keeps one side consistent across pieces drawn in opposite directions", () => {
    const feature = road(line([-50, 0], [50, 0]), WIDTH);
    const centerline: MultiLineString = {
      type: "MultiLineString",
      coordinates: [[at(-50, 0), at(0, 0)], [at(50, 0), at(0, 0)]] as Position[][],
    };
    const split = { ...feature, properties: { ...feature.properties, centerline } };
    const result = covered(coverRoad(split, cover({ road: false, sides: "left" })));
    expect(inside(result, -20, 8)).toBe(true);
    expect(inside(result, 20, 8)).toBe(true);
    expect(inside(result, 0, 8)).toBe(true);
    expect(inside(result, 20, -8)).toBe(false);
  });

  it("follows a corner where two pieces meet without leaking outside it", () => {
    const feature = road(line([0, -80], [0, 0], [-50, 0]), WIDTH);
    const centerline: MultiLineString = {
      type: "MultiLineString",
      coordinates: [[at(0, -80), at(0, 0)], [at(0, 0), at(-50, 0)]] as Position[][],
    };
    const corner = { ...feature, properties: { ...feature.properties, centerline } };
    const inner = covered(coverRoad(corner, cover({ road: false, sides: "left" })));
    expect(inside(inner, -8, -8)).toBe(true);
    expect(inside(inner, -6, 8)).toBe(false);
    expect(inside(inner, 7, 7)).toBe(false);
    const outer = covered(coverRoad(corner, cover({ road: false, sides: "right" })));
    expect(inside(outer, 7, 7)).toBe(true);
    expect(inside(outer, -20, 8)).toBe(true);
    expect(outer.geometry.type).toBe("Polygon");
  });

  it("keeps a side road's strip off the far side of the main road", () => {
    const feature = road(line([-50, 0], [50, 0]), WIDTH);
    const centerline: MultiLineString = {
      type: "MultiLineString",
      coordinates: [[at(-50, 0), at(50, 0)], [at(0, 0), at(0, 50)]] as Position[][],
    };
    const shape = covered(coverRoad({ ...feature, properties: { ...feature.properties, centerline } }, cover({})));
    const withBranch = road(line([0, 0], [0, 50]), WIDTH);
    const merged = { ...shape, geometry: { type: "MultiPolygon" as const, coordinates: [
      ...(shape.geometry.type === "Polygon" ? [shape.geometry.coordinates] : shape.geometry.coordinates),
      (withBranch.geometry as { coordinates: Position[][] }).coordinates,
    ] } };
    const result = covered(coverRoad(merged, cover({ road: false, sides: "left" })));
    expect(inside(result, -20, 8)).toBe(true);
    expect(inside(result, -6, -6)).toBe(false);
  });

  it("only covers roads", () => {
    const { centerline, ...rest } = straight().properties;
    expect(coverRoad({ ...straight(), properties: rest }, cover({}))).toEqual({ error: "Only roads have sides to cover." });
  });
});
