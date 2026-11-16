import { describe, expect, it } from "vitest";
import { cutAt } from "../src/cut.ts";
import { makeFeature } from "../src/wand.ts";
import { at, inside, line, rect, road } from "./fixtures.ts";

describe("cutAt on a road", () => {
  const street = road(line([0, 0], [300, 0]), 8);

  it("keeps the side of the first click and drops the rest", () => {
    const cut = cutAt(street, at(20, 0), at(150, 1))!;
    expect(inside(cut, 20, 0)).toBe(true);
    expect(inside(cut, 140, 0)).toBe(true);
    expect(inside(cut, 160, 0)).toBe(false);
    expect(inside(cut, 280, 0)).toBe(false);
    expect(cut.properties.cuts).toBe(1);
    expect(cut.properties.area_m2).toBeLessThan(street.properties.area_m2 * 0.6);
  });

  it("cuts perpendicular to the road even when the click is off the centerline", () => {
    const cut = cutAt(street, at(20, 0), at(150, 3))!;
    expect(inside(cut, 149, -3)).toBe(true);
    expect(inside(cut, 151, -3)).toBe(false);
  });

  it("two cuts on both sides of the first click leave the segment between them", () => {
    const once = cutAt(street, at(150, 0), at(250, 0))!;
    const twice = cutAt(once, at(150, 0), at(50, 0))!;
    expect(inside(twice, 150, 0)).toBe(true);
    expect(inside(twice, 40, 0)).toBe(false);
    expect(inside(twice, 260, 0)).toBe(false);
    expect(twice.properties.cuts).toBe(2);
  });

  it("drops parts of the road that bend back past the cut", () => {
    const uTurn = road(line([0, 0], [200, 0], [200, 60], [0, 60]), 8);
    const cut = cutAt(uTurn, at(20, 0), at(100, 0))!;
    expect(inside(cut, 20, 0)).toBe(true);
    expect(inside(cut, 150, 0)).toBe(false);
    expect(inside(cut, 20, 60)).toBe(false);
  });
});

describe("cutAt on an area", () => {
  const building = makeFeature(rect(0, 0, 40, 20), { source: "osm", kind: "building", label: "building" });

  it("cuts perpendicular to the line from the first click", () => {
    const cut = cutAt(building, at(5, 10), at(20, 10))!;
    expect(inside(cut, 5, 10)).toBe(true);
    expect(inside(cut, 30, 10)).toBe(false);
    expect(cut.properties.area_m2).toBeCloseTo(building.properties.area_m2 / 2, -1);
  });

  it("returns null when the cut is on the first click", () => {
    expect(cutAt(building, at(5, 10), at(5, 10))).toBeNull();
  });
});
