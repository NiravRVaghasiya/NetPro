import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "./rrf";
import { RRF_K } from "./types";

/**
 * RRF is the one piece of hybrid search that must behave identically on both
 * dialects, so it is tested against hand-computed values rather than against
 * "the order looks plausible".
 */
describe("reciprocalRankFusion", () => {
  it("scores a single list as 1/(k+rank)", () => {
    const fused = reciprocalRankFusion([{ arm: "a", ids: ["x", "y", "z"] }]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y", "z"]);
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(fused[1]!.score).toBeCloseTo(1 / (RRF_K + 2), 12);
    expect(fused[2]!.score).toBeCloseTo(1 / (RRF_K + 3), 12);
    expect(fused[0]!.ranks).toEqual({ a: 1 });
  });

  it("sums contributions across arms — agreement beats a single #1", () => {
    // "b" is 2nd in both arms; "a" is 1st in one and absent from the other.
    //   a: 1/61            = 0.016393…
    //   b: 1/62 + 1/62     = 0.032258…
    const fused = reciprocalRankFusion([
      { arm: "kw", ids: ["a", "b"] },
      { arm: "vec", ids: ["c", "b"] },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(fused[0]!.score).toBeCloseTo(2 / 62, 12);
    expect(fused[0]!.arms).toEqual(["kw", "vec"]);
    expect(fused[0]!.ranks).toEqual({ kw: 2, vec: 2 });
    // a and c are both rank 1 in one arm — identical scores, id breaks the tie.
    expect(fused[1]!.score).toBeCloseTo(fused[2]!.score, 12);
  });

  it("applies per-arm weights", () => {
    // Same rank in both arms, but the weighted arm wins.
    const fused = reciprocalRankFusion([
      { arm: "strong", ids: ["a"], weight: 1 },
      { arm: "weak", ids: ["b"], weight: 0.5 },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 12);
    expect(fused[1]!.score).toBeCloseTo(0.5 / 61, 12);
  });

  it("ignores zero-weight and empty lists", () => {
    const fused = reciprocalRankFusion([
      { arm: "off", ids: ["a", "b"], weight: 0 },
      { arm: "empty", ids: [] },
      { arm: "on", ids: ["c"] },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["c"]);
  });

  it("does not double-count a duplicate id inside one list", () => {
    const fused = reciprocalRankFusion([{ arm: "a", ids: ["x", "x", "y"] }]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 12);
    // "y" is rank 2, not rank 3 — the duplicate did not consume a rank slot.
    expect(fused[1]!.ranks).toEqual({ a: 2 });
  });

  it("is deterministic for fully tied candidates", () => {
    const lists = [
      { arm: "a", ids: ["zeta", "alpha"] },
      { arm: "b", ids: ["alpha", "zeta"] },
    ];
    const once = reciprocalRankFusion(lists).map((f) => f.id);
    const twice = reciprocalRankFusion(lists).map((f) => f.id);
    expect(once).toEqual(twice);
    // Identical scores and arm counts → lowest id first.
    expect(once).toEqual(["alpha", "zeta"]);
  });

  it("honours a custom k", () => {
    const fused = reciprocalRankFusion([{ arm: "a", ids: ["x"] }], 1);
    expect(fused[0]!.score).toBeCloseTo(1 / 2, 12);
  });

  it("rejects a non-positive k rather than dividing by a negative", () => {
    expect(() => reciprocalRankFusion([{ arm: "a", ids: ["x"] }], 0)).toThrow(
      /positive number/,
    );
    expect(() => reciprocalRankFusion([{ arm: "a", ids: ["x"] }], -5)).toThrow();
  });

  it("returns an empty array for no lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});
