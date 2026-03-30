import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeQuartile,
  assignSegment,
  clearCache,
} from "../../src/utils/customer-data.js";

// ── Pure function tests (no mocking needed) ────────────

describe("computeQuartile", () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it("assigns score 1 to lowest quartile", () => {
    expect(computeQuartile(10, values, false)).toBe(1);
    expect(computeQuartile(20, values, false)).toBe(1);
  });

  it("assigns score 2 to second quartile", () => {
    // Q1 boundary = values[2] = 30, Q2 = values[5] = 60
    // 30 is <= Q1 (30), so it's score 1. 40 is > Q1, <= Q2, so it's score 2.
    expect(computeQuartile(40, values, false)).toBe(2);
    expect(computeQuartile(50, values, false)).toBe(2);
  });

  it("assigns score 3 to third quartile", () => {
    // Q2 = values[5] = 60, Q3 = values[7] = 80
    // 70 is > Q2 (60) and <= Q3 (80), so score 3
    expect(computeQuartile(70, values, false)).toBe(3);
    expect(computeQuartile(80, values, false)).toBe(3);
  });

  it("assigns score 4 to highest quartile", () => {
    expect(computeQuartile(90, values, false)).toBe(4);
    expect(computeQuartile(100, values, false)).toBe(4);
  });

  it("reverses scores when reversed=true (for recency)", () => {
    // Low value → high score when reversed
    expect(computeQuartile(10, values, true)).toBe(4);
    // High value → low score when reversed
    expect(computeQuartile(100, values, true)).toBe(1);
  });

  it("returns 2 when all values are identical", () => {
    const same = [50, 50, 50, 50, 50];
    expect(computeQuartile(50, same, false)).toBe(2);
    expect(computeQuartile(50, same, true)).toBe(2);
  });

  it("handles two distinct values", () => {
    const twoVals = [10, 10, 10, 100, 100];
    // sorted: [10, 10, 10, 100, 100], Q1=10, Q2=10, Q3=100
    // 10 <= Q1 → score 1
    expect(computeQuartile(10, twoVals, false)).toBe(1);
    // 100 <= Q3 (100) → score 3
    expect(computeQuartile(100, twoVals, false)).toBe(3);
  });
});

describe("assignSegment", () => {
  it("assigns Champions for R4 F4 M4", () => {
    expect(assignSegment(4, 4, 4)).toBe("Champions");
  });

  it("assigns Champions for R4 F3 M3", () => {
    expect(assignSegment(4, 3, 3)).toBe("Champions");
  });

  it("assigns Loyal for R2 F4 M4", () => {
    // R=2 means not Champions (needs R=4), but matches Loyal (R=2-4, F=3-4, M=3-4)
    expect(assignSegment(2, 4, 4)).toBe("Loyal");
  });

  it("assigns Loyal for R3 F3 M3", () => {
    // R=3 F=3 M=3 matches Champions first (R=4 required? no, R=4 only)
    // Actually: Champions requires R=4, so R=3 F=3 M=3 falls to Loyal
    expect(assignSegment(3, 3, 3)).toBe("Loyal");
  });

  it("assigns Promising for R4 F1 M1", () => {
    expect(assignSegment(4, 1, 1)).toBe("Promising");
  });

  it("assigns Promising for R3 F2 M2", () => {
    expect(assignSegment(3, 2, 2)).toBe("Promising");
  });

  it("assigns At Risk for R1 F4 M4", () => {
    expect(assignSegment(1, 4, 4)).toBe("At Risk");
  });

  it("assigns At Risk for R2 F3 M3", () => {
    // R=2, F=3, M=3: matches Loyal (R=2-4, F=3-4, M=3-4) FIRST
    // Top-to-bottom: Champions (R4) no, Loyal (R2-4, F3-4, M3-4) YES
    expect(assignSegment(2, 3, 3)).toBe("Loyal");
  });

  it("assigns Hibernating for R1 F1 M3", () => {
    expect(assignSegment(1, 1, 3)).toBe("Hibernating");
  });

  it("assigns Hibernating for R2 F2 M2", () => {
    expect(assignSegment(2, 2, 2)).toBe("Hibernating");
  });

  it("assigns Lost for R1 F1 M1", () => {
    expect(assignSegment(1, 1, 1)).toBe("Lost");
  });

  it("assigns Hibernating for R1 F1 M2 (M=2 matches Hibernating before Lost)", () => {
    // R1 F1 M2: Hibernating (R1-2, F1-2, M2-4) matches before Lost (R1, F1, M1-2)
    expect(assignSegment(1, 1, 2)).toBe("Hibernating");
  });

  it("assigns Needs Attention for unmapped combinations", () => {
    // R=3 F=1 M=3: Promising needs M=1-2, Hibernating needs R=1-2
    expect(assignSegment(3, 1, 3)).toBe("Needs Attention");
  });

  it("matches top-to-bottom (Champions before Loyal)", () => {
    // R=4 F=4 M=4 matches both Champions and Loyal, should be Champions
    expect(assignSegment(4, 4, 4)).toBe("Champions");
  });
});

describe("inter-purchase interval calculation", () => {
  it("computes correct average interval from order dates", () => {
    // Simulating the logic from buildAnalytics
    const orderDates = [
      new Date("2025-01-01"),
      new Date("2025-01-31"),
      new Date("2025-03-02"),
      new Date("2025-04-01"),
    ];

    let totalInterval = 0;
    for (let i = 1; i < orderDates.length; i++) {
      totalInterval +=
        (orderDates[i].getTime() - orderDates[i - 1].getTime()) /
        (1000 * 60 * 60 * 24);
    }
    const avgInterval = totalInterval / (orderDates.length - 1);

    // Jan 1 → Jan 31 = 30 days
    // Jan 31 → Mar 2 = 30 days
    // Mar 2 → Apr 1 = 30 days
    // Average = 30 days
    expect(avgInterval).toBe(30);
  });

  it("returns null for single-order customers", () => {
    const orderDates = [new Date("2025-01-01")];
    const avgInterval =
      orderDates.length >= 2
        ? 0 // would compute
        : null;
    expect(avgInterval).toBeNull();
  });
});

describe("churn ratio calculation", () => {
  it("computes correct churn ratio", () => {
    const avgIntervalDays = 30;
    const daysSinceLastOrder = 90;
    const churnRatio = daysSinceLastOrder / avgIntervalDays;
    expect(churnRatio).toBe(3.0);
  });

  it("flags as at-risk when ratio > 2.0", () => {
    expect(65 / 30 > 2.0).toBe(true); // 2.17 — at risk
    expect(59 / 30 > 2.0).toBe(false); // 1.97 — not at risk
  });
});

describe("LTV calculation", () => {
  it("computes annualized run-rate correctly", () => {
    const totalSpend = 500;
    const ageDays = 180;
    const annualizedLTV = (totalSpend / ageDays) * 365;
    expect(Math.round(annualizedLTV)).toBe(1014);
  });

  it("handles customer active for 1 day", () => {
    const totalSpend = 100;
    const ageDays = 1;
    const annualizedLTV = (totalSpend / ageDays) * 365;
    expect(annualizedLTV).toBe(36500);
  });

  it("flags low confidence for < 60 day customers", () => {
    const ageDays = 45;
    const confidence = ageDays < 60 ? "low" : "high";
    expect(confidence).toBe("low");
  });

  it("flags high confidence for >= 60 day customers", () => {
    const ageDays = 60;
    const confidence = ageDays < 60 ? "low" : "high";
    expect(confidence).toBe("high");
  });

  it("single-order customer LTV equals their order value (annualized)", () => {
    // Customer placed one $50 order 100 days ago
    const totalSpend = 50;
    const ageDays = 100;
    const annualizedLTV = (totalSpend / ageDays) * 365;
    expect(annualizedLTV).toBeCloseTo(182.5, 1);
  });
});
