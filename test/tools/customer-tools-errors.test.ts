/**
 * Tests for tool-level error handling and health report finding logic.
 * Covers GAPs #43-56: error propagation and health report findings thresholds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CustomerAnalytics, CustomerRecord } from "../../src/utils/customer-data.js";

vi.mock("../../src/utils/customer-data.js", () => ({
  getCustomerAnalytics: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock("../../src/shopify-client.js", () => ({
  runShopifyQL: vi.fn(),
  graphql: vi.fn(),
  getStoreCurrency: vi.fn().mockResolvedValue("USD"),
}));

import { getCustomerAnalytics } from "../../src/utils/customer-data.js";

const mockGetCustomerAnalytics = vi.mocked(getCustomerAnalytics);

// ── Helpers ────────────────────────────────────────────

function makeCustomer(overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  const now = new Date();
  return {
    name: "Test",
    email: "test@example.com",
    totalSpend: 500,
    orderCount: 5,
    firstOrderDate: new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000),
    lastOrderDate: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
    orderDates: [],
    avgIntervalDays: 30,
    daysSinceLastOrder: 10,
    rfmScores: { r: 3, f: 3, m: 3 },
    segment: "Loyal",
    churnRatio: 0.33,
    annualizedLTV: 1014,
    ltvConfidence: "high" as const,
    ...overrides,
  };
}

function makeAnalytics(
  customers: CustomerRecord[],
  overrides: Partial<CustomerAnalytics> = {}
): CustomerAnalytics {
  const segmentCounts: Record<string, number> = {};
  for (const c of customers) {
    segmentCounts[c.segment] = (segmentCounts[c.segment] ?? 0) + 1;
  }
  return {
    customers,
    segmentCounts,
    totalCustomers: customers.length,
    totalRevenue: customers.reduce((sum, c) => sum + c.totalSpend, 0),
    period: "last_12m",
    dataSource: "shopifyql" as const,
    currency: "USD",
    ...overrides,
  };
}

interface ToolHandler {
  (args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    tools,
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(_name, handler);
    },
  };
}

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return { ...JSON.parse(result.content[0].text), isError: result.isError };
}

// ── GAPs #43-46: Tool error handling ───────────────────

describe("tool error handling", () => {
  // GAP #43: RFM tool error
  it("get_customer_rfm_segments returns toolError on API failure", async () => {
    mockGetCustomerAnalytics.mockRejectedValue(new Error("Shopify API rate limit reached"));
    const server = createMockServer();
    const { registerCustomerRfmSegments } = await import("../../src/tools/customer-rfm-segments.js");
    registerCustomerRfmSegments(server as any);

    const result = await server.tools.get("get_customer_rfm_segments")!({});
    const parsed = parseResult(result);

    expect(parsed.isError).toBe(true);
    expect(parsed.error).toContain("rate limit");
  });

  // GAP #44: Churn tool error
  it("get_customer_churn_risk returns toolError on API failure", async () => {
    mockGetCustomerAnalytics.mockRejectedValue(new Error("Authentication failed (401)"));
    const server = createMockServer();
    const { registerCustomerChurnRisk } = await import("../../src/tools/customer-churn-risk.js");
    registerCustomerChurnRisk(server as any);

    const result = await server.tools.get("get_customer_churn_risk")!({});
    const parsed = parseResult(result);

    expect(parsed.isError).toBe(true);
    expect(parsed.error).toContain("Authentication failed");
  });

  // GAP #45: LTV tool error
  it("get_customer_ltv_summary returns toolError on API failure", async () => {
    mockGetCustomerAnalytics.mockRejectedValue(new Error("Network timeout"));
    const server = createMockServer();
    const { registerCustomerLtvSummary } = await import("../../src/tools/customer-ltv-summary.js");
    registerCustomerLtvSummary(server as any);

    const result = await server.tools.get("get_customer_ltv_summary")!({});
    const parsed = parseResult(result);

    expect(parsed.isError).toBe(true);
    expect(parsed.error).toContain("Network timeout");
  });

  // GAP #46: Health report error
  it("get_customer_health_report returns toolError on API failure", async () => {
    mockGetCustomerAnalytics.mockRejectedValue(new Error("Missing required API scope"));
    const server = createMockServer();
    const { registerCustomerHealthReport } = await import("../../src/tools/customer-health-report.js");
    registerCustomerHealthReport(server as any);

    const result = await server.tools.get("get_customer_health_report")!({});
    const parsed = parseResult(result);

    expect(parsed.isError).toBe(true);
    expect(parsed.error).toContain("API scope");
  });
});

// ── GAPs #47-56: Health report findings logic ──────────

describe("health report findings thresholds", () => {
  let server: ReturnType<typeof createMockServer>;
  let handler: ToolHandler;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    const { registerCustomerHealthReport } = await import("../../src/tools/customer-health-report.js");
    registerCustomerHealthReport(server as any);
    handler = server.tools.get("get_customer_health_report")!;
  });

  // GAP #47: Revenue concentration > 50% → medium finding
  it("flags high revenue concentration (>50%) as medium severity", async () => {
    // 10 customers: top 1 customer (10%) has 60% of revenue
    const customers = [
      makeCustomer({ name: "Whale", totalSpend: 6000, orderCount: 10 }),
      ...Array.from({ length: 9 }, (_, i) =>
        makeCustomer({
          name: `Small ${i}`,
          email: `s${i}@test.com`,
          totalSpend: 444,
          orderCount: 2,
        })
      ),
    ];
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    const concFinding = parsed.data.findings.find((f: any) =>
      f.finding.includes("drive")
    );
    expect(concFinding).toBeDefined();
    expect(concFinding.severity).toBe("medium");
  });

  // GAP #48: Revenue concentration <= 50% → no finding
  it("does not flag low revenue concentration (<=50%)", async () => {
    // 10 customers with equal spend
    const customers = Array.from({ length: 10 }, (_, i) =>
      makeCustomer({
        name: `Equal ${i}`,
        email: `e${i}@test.com`,
        totalSpend: 100,
        orderCount: 2,
      })
    );
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    const concFinding = parsed.data.findings.find((f: any) =>
      f.finding.includes("drive") && f.finding.includes("revenue")
    );
    expect(concFinding).toBeUndefined();
  });

  // GAP #49: Repeat rate < 20% → high finding
  it("flags very low repeat rate (<20%) as high severity", async () => {
    // 10 customers: 1 repeat, 9 one-time = 10% repeat rate
    const customers = [
      makeCustomer({ name: "Repeat", orderCount: 3 }),
      ...Array.from({ length: 9 }, (_, i) =>
        makeCustomer({
          name: `OneTime ${i}`,
          email: `ot${i}@test.com`,
          totalSpend: 50,
          orderCount: 1,
        })
      ),
    ];
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    const repeatFinding = parsed.data.findings.find(
      (f: any) => f.finding.includes("ordered more than once") || f.finding.includes("repeat")
    );
    expect(repeatFinding).toBeDefined();
    expect(repeatFinding.severity).toBe("high");
  });

  // GAP #50: Repeat rate 20-40% → medium finding
  it("flags moderate repeat rate (20-40%) as medium severity", async () => {
    // 10 customers: 3 repeat = 30%
    const customers = [
      ...Array.from({ length: 3 }, (_, i) =>
        makeCustomer({
          name: `Repeat ${i}`,
          email: `r${i}@test.com`,
          orderCount: 3,
        })
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        makeCustomer({
          name: `OneTime ${i}`,
          email: `ot${i}@test.com`,
          totalSpend: 50,
          orderCount: 1,
        })
      ),
    ];
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    const repeatFinding = parsed.data.findings.find(
      (f: any) => f.finding.includes("repeat purchase rate")
    );
    expect(repeatFinding).toBeDefined();
    expect(repeatFinding.severity).toBe("medium");
  });

  // GAP #51: Repeat rate > 40% → no finding
  it("does not flag high repeat rate (>40%)", async () => {
    // 10 customers: 5 repeat = 50%
    const customers = Array.from({ length: 10 }, (_, i) =>
      makeCustomer({
        name: `Customer ${i}`,
        email: `c${i}@test.com`,
        orderCount: i < 5 ? 3 : 1,
      })
    );
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    const repeatFinding = parsed.data.findings.find(
      (f: any) =>
        f.finding.includes("ordered more than once") ||
        f.finding.includes("repeat purchase rate")
    );
    expect(repeatFinding).toBeUndefined();
  });

  // GAP #52: Champions > 15% → low finding
  it("flags strong Champions presence (>15%) as low severity", async () => {
    // 20 customers: 4 Champions (20%) — need >= 20 for segments
    const customers = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeCustomer({
          name: `Champ ${i}`,
          email: `ch${i}@test.com`,
          segment: "Champions",
          orderCount: 10,
          totalSpend: 2000,
        })
      ),
      ...Array.from({ length: 16 }, (_, i) =>
        makeCustomer({
          name: `Other ${i}`,
          email: `o${i}@test.com`,
          segment: "Loyal",
          orderCount: 3,
          totalSpend: 200,
        })
      ),
    ];
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    const champFinding = parsed.data.findings.find((f: any) =>
      f.finding.includes("Champions")
    );
    expect(champFinding).toBeDefined();
    expect(champFinding.severity).toBe("low");
  });

  // GAP #53: Champions <= 15% → no Champions finding
  it("does not flag Champions when <= 15%", async () => {
    // 20 customers: 2 Champions (10%)
    const customers = [
      ...Array.from({ length: 2 }, (_, i) =>
        makeCustomer({
          name: `Champ ${i}`,
          email: `ch${i}@test.com`,
          segment: "Champions",
        })
      ),
      ...Array.from({ length: 18 }, (_, i) =>
        makeCustomer({
          name: `Other ${i}`,
          email: `o${i}@test.com`,
          segment: "Loyal",
        })
      ),
    ];
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    const champFinding = parsed.data.findings.find((f: any) =>
      f.finding.includes("Champions")
    );
    expect(champFinding).toBeUndefined();
  });

  // GAP #54: Findings sorted by severity
  it("sorts findings high → medium → low", async () => {
    // Create conditions for all three severity levels
    const customers = [
      // Champions > 15% (need 20+ total for segments)
      ...Array.from({ length: 5 }, (_, i) =>
        makeCustomer({
          name: `Champ ${i}`,
          email: `ch${i}@test.com`,
          segment: "Champions",
          orderCount: 10,
          totalSpend: 5000, // high spend to trigger concentration
        })
      ),
      // At-risk customers
      ...Array.from({ length: 5 }, (_, i) =>
        makeCustomer({
          name: `AtRisk ${i}`,
          email: `ar${i}@test.com`,
          segment: "At Risk",
          orderCount: 5,
          churnRatio: 3.0,
          totalSpend: 1000,
          avgIntervalDays: 30,
          daysSinceLastOrder: 90,
          lastOrderDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        })
      ),
      // One-time buyers (low repeat rate)
      ...Array.from({ length: 15 }, (_, i) =>
        makeCustomer({
          name: `OneTime ${i}`,
          email: `ot${i}@test.com`,
          segment: "Lost",
          orderCount: 1,
          totalSpend: 50,
          churnRatio: null,
          avgIntervalDays: null,
        })
      ),
    ];
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    const severities = parsed.data.findings.map((f: any) => f.severity);
    // All "high" before all "medium" before all "low"
    for (let i = 1; i < severities.length; i++) {
      const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
      expect(order[severities[i]]).toBeGreaterThanOrEqual(order[severities[i - 1]]);
    }
  });

  // GAP #55: No findings → healthy summary
  it("reports healthy when no findings triggered", async () => {
    // 10 customers, all repeat, even spend — no thresholds hit
    const customers = Array.from({ length: 10 }, (_, i) =>
      makeCustomer({
        name: `Healthy ${i}`,
        email: `h${i}@test.com`,
        segment: "Loyal",
        orderCount: 5,
        totalSpend: 100, // even distribution
      })
    );
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    expect(parsed.summary).toContain("healthy");
    expect(parsed.data.findings).toHaveLength(0);
  });

  // GAP #56: sections_available reflects successful analyses
  it("lists all available sections when everything succeeds", async () => {
    const customers = Array.from({ length: 10 }, (_, i) =>
      makeCustomer({
        name: `Customer ${i}`,
        email: `c${i}@test.com`,
        orderCount: 3,
      })
    );
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const result = await handler({});
    const parsed = parseResult(result);

    expect(parsed.data.sections_available).toContain("segments");
    expect(parsed.data.sections_available).toContain("revenue_concentration");
    expect(parsed.data.sections_available).toContain("churn_risk");
    expect(parsed.data.sections_available).toContain("repeat_purchase");
  });
});
