import { describe, expect, it } from "vitest";
import type { OsmHit } from "../src/osm.ts";
import { buildingGroup, makeFeature, rankByLasso } from "../src/wand.ts";
import { rect } from "./fixtures.ts";

const house = makeFeature(rect(0, 0, 20, 15), { source: "osm", kind: "building", label: "house" });
const garden = makeFeature(rect(-30, -30, 60, 50), { source: "osm", kind: "area", label: "garden" });
const neighbour = makeFeature(rect(40, 0, 60, 15), { source: "osm", kind: "building", label: "neighbour" });

describe("rankByLasso", () => {
  it("prefers the object that fills a loose outline around it", () => {
    const ranked = rankByLasso([garden, neighbour, house], rect(-3, -3, 23, 18));
    expect(ranked[0].properties.label).toBe("house");
    expect(ranked[0].properties.fit).toBeGreaterThan(0.5);
  });

  it("drops objects that are mostly outside the lasso", () => {
    const labels = rankByLasso([garden, neighbour, house], rect(-3, -3, 23, 18)).map((f) => f.properties.label);
    expect(labels).not.toContain("neighbour");
    expect(labels).not.toContain("garden");
  });

  it("picks the big area when the lasso is drawn around it", () => {
    expect(rankByLasso([garden, house], rect(-32, -32, 62, 52))[0].properties.label).toBe("garden");
  });
});

describe("buildingGroup", () => {
  const hit = (f: typeof house): OsmHit => ({ kind: "building", geometry: f.geometry, tags: { building: "yes" }, label: "building" });

  it("groups buildings that are inside the lasso", () => {
    const group = buildingGroup([hit(house), hit(neighbour)], rect(-5, -5, 65, 20))!;
    expect(group.properties.label).toBe("2 buildings");
    expect(group.geometry.type).toBe("MultiPolygon");
  });

  it("needs at least two buildings", () => {
    expect(buildingGroup([hit(house), hit(neighbour)], rect(-5, -5, 25, 20))).toBeNull();
  });
});
