import { describe, expect, it } from "vitest";
import type { WandFeature } from "@map-wand/shared";
import { cutAt } from "../src/cut.ts";
import { type ExtendOutcome, extendRoad } from "../src/extend.ts";
import type { OsmRoad } from "../src/osm.ts";
import { at, inside, line, road } from "./fixtures.ts";

const HIT_M = 6;
const WIDTH = 7;

const osmRoad = (highway: string, ...points: [number, number][]): OsmRoad => ({
  line: line(...points),
  tags: { highway },
  width: WIDTH,
});

const mainRoad = [
  osmRoad("residential", [-200, 0], [0, 0]),
  osmRoad("residential", [0, 0], [100, 0]),
  osmRoad("residential", [100, 0], [300, 0]),
];

function selected(): WandFeature {
  const feature = road(line([-50, 0], [50, 0]), WIDTH);
  return { ...feature, properties: { ...feature.properties, osm_tags: { highway: "residential" } } };
}

function extended(outcome: ExtendOutcome): WandFeature {
  if (!("feature" in outcome)) throw new Error(outcome.error);
  return outcome.feature;
}

describe("extendRoad", () => {
  it("lengthens the road up to the click", () => {
    const result = extended(extendRoad(selected(), at(150, 2), mainRoad, HIT_M));
    expect(inside(result, 0, 0)).toBe(true);
    expect(inside(result, 120, 0)).toBe(true);
    expect(inside(result, 148, 0)).toBe(true);
    expect(inside(result, 170, 0)).toBe(false);
    expect(inside(result, -80, 0)).toBe(false);
    expect(result.properties.extensions).toBe(1);
    expect(result.properties.area_m2).toBeGreaterThan(selected().properties.area_m2);
  });

  it("extends in either direction", () => {
    const result = extended(extendRoad(selected(), at(-120, -1), mainRoad, HIT_M));
    expect(inside(result, -100, 0)).toBe(true);
    expect(inside(result, 80, 0)).toBe(false);
  });

  it("grows back past an earlier cut", () => {
    const cut = cutAt(selected(), at(-40, 0), at(20, 0))!;
    expect(inside(cut, 40, 0)).toBe(false);
    const result = extended(extendRoad(cut, at(60, 0), mainRoad, HIT_M));
    expect(inside(result, 40, 0)).toBe(true);
  });

  it("turns into a side road that meets the main road without a shared vertex", () => {
    const roads = [...mainRoad, osmRoad("residential", [70, 1.5], [70, 150])];
    const result = extended(extendRoad(selected(), at(70, 100), roads, HIT_M));
    expect(inside(result, 70, 50)).toBe(true);
    expect(inside(result, 70, 130)).toBe(false);
  });

  it("refuses roads that do not connect to the selection", () => {
    const roads = [...mainRoad, osmRoad("residential", [-100, 40], [100, 40])];
    expect(extendRoad(selected(), at(0, 40), roads, HIT_M)).toEqual({ error: "This road does not connect to the selection." });
  });

  it("refuses points that are only reachable by a long detour", () => {
    const roads = [
      osmRoad("residential", [-50, 0], [50, 0]),
      osmRoad("residential", [50, 0], [50, 400], [90, 400], [90, 10]),
    ];
    expect(extendRoad(selected(), at(90, 12), roads, HIT_M)).toEqual({ error: "That point is not along this road." });
  });

  it("reports clicks away from any road", () => {
    expect(extendRoad(selected(), at(150, 40), mainRoad, HIT_M)).toEqual({ error: "No road here to extend to." });
  });

  it("reports clicks on the part that is already selected", () => {
    expect(extendRoad(selected(), at(0, 5), mainRoad, HIT_M)).toEqual({ error: "That part of the road is already selected." });
  });

  it("only extends roads", () => {
    const { centerline, ...rest } = selected().properties;
    expect(extendRoad({ ...selected(), properties: rest }, at(150, 0), mainRoad, HIT_M)).toEqual({ error: "Only roads can be extended." });
  });
});
