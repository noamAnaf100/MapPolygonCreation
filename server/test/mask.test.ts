import { describe, expect, it } from "vitest";
import { type Mask, maskToPolygons, pickPolygon, polygonArea } from "../src/mask.ts";

function mask(width: number, height: number, ...rects: [number, number, number, number, number][]): Mask {
  const data = new Uint8Array(width * height);
  for (const [x0, y0, x1, y1, value] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * width + x] = value;
  }
  return { width, height, data };
}

describe("maskToPolygons", () => {
  it("traces a filled rectangle", () => {
    const [polygon, ...rest] = maskToPolygons(mask(50, 50, [10, 10, 30, 20, 1]));
    expect(rest).toHaveLength(0);
    expect(polygonArea(polygon)).toBeCloseTo(200, -1);
  });

  it("keeps holes and drops specks", () => {
    const polygons = maskToPolygons(mask(60, 60, [5, 5, 45, 45, 1], [15, 15, 30, 30, 0], [50, 50, 52, 52, 1]));
    expect(polygons).toHaveLength(1);
    expect(polygons[0].coordinates).toHaveLength(2);
    expect(polygonArea(polygons[0])).toBeCloseTo(1600 - 225, -1);
  });
});

describe("pickPolygon", () => {
  const polygons = maskToPolygons(mask(100, 100, [5, 5, 15, 15, 1], [40, 40, 90, 90, 1]));

  it("picks the part under the click", () => {
    expect(polygonArea(pickPolygon(polygons, [10, 10])!)).toBeCloseTo(100, -1);
  });

  it("falls back to the largest part", () => {
    expect(polygonArea(pickPolygon(polygons, [30, 30])!)).toBeCloseTo(2500, -1);
  });
});
