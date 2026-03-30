import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CustomerAnalytics, CustomerRecord } from "../../src/utils/customer-data.js";

// Mock the customer-data module before importing tools
vi.mock("../../src/utils/customer-data.js", () => ({
  getCustomerAnalytics: vi.fn(),
  clearCache: vi.fn(),
}));

// Mock shopify-client (tools import formatters which may reference it)
vi.mock("../../src/shopify-client.js", () => ({
  runShopifyQL: vi.fn(),
  graphql: vi.fn(),
  getStoreCurrency: vi.fn().mockResolvedValue("USD"),
}));

import { getCustomerAnalytics } from "../../src/utils/customer-data.js";

const mockGetCustomerAnalytics = vi.mocked(getCustomerAnalytics);

// ── Test fixtures ──────────────────────────────────────

function makeCustomer(overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  const now = new Date();
  return {
    name: "Test Customer",
    email: "test@example.com",
    totalSpend: 500,
    orderCount: 5,
    firstOrderDate: new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000),
    lastOrderDate: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
    orderDates: [],
    avgIntervalDays: 30,
    daysSinceLastOrder: 10,
    rfmScores: { r: 4, f: 4, m: 4 },
    segment: "Champions",
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

// ── Helper to call a registered tool ───────────────────

interface ToolHandler {
  (args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function createMockServer(): {
  tools: Map<string, ToolHandler>;
  tool: (
    name: string,
    desc: string,
    schema: unknown,
    handler: ToolHandler
  ) => void;
} {
  const tools = new Map<string, ToolHandler>();
  return {
    tools,
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(_name, handler);
    },
  };
}

function parseToolResult(result: {
  content: Array<{ type: string; text: string }>;
}) {
  return JSON.parse(result.content[0].text);
}

// ── RFM Segments Tool Tests ────────────────────────────

describe("get_customer_rfm_segments", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    const { registerCustomerRfmSegments } = await import(
      "../../src/tools/customer-rfm-segments.js"
    );
    registerCustomerRfmSegments(server as any);
  });

  it("returns segment breakdown for normal store", async () => {
    const customers = Array.from({ length: 30 }, (_, i) =>
      makeCustomer({
        name: `Customer ${i}`,
        email: `c${i}@test.com`,
        segment: i < 5 ? "Champions" : i < 15 ? "Loyal" : "At Risk",
        totalSpend: 100 * (30 - i),
      })
    );
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const handler = server.tools.get("get_customer_rfm_segments")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.summary).toContain("30 customers analyzed");
    expect(parsed.data.segments).toBeDefined();
    expect(parsed.data.segments["Champions"].count).toBe(5);
    expect(parsed.data.segments["Loyal"].count).toBe(10);
  });

  it("returns flat list for < 20 customers", async () => {
    const customers = Array.from({ length: 5 }, (_, i) =>
      makeCustomer({
        name: `Customer ${i}`,
        email: `c${i}@test.com`,
        segment: "N/A",
      })
    );
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const handler = server.tools.get("get_customer_rfm_segments")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.summary).toContain("Too few customers");
    expect(parsed.data.customers).toHaveLength(5);
  });

  it("handles empty result", async () => {
    mockGetCustomerAnalytics.mockResolvedValue(
      makeAnalytics([], { totalCustomers: 0 })
    );

    const handler = server.tools.get("get_customer_rfm_segments")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.summary).toContain("No customers found");
  });
});

// ── Churn Risk Tool Tests ──────────────────────────────

describe("get_customer_churn_risk", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    const { registerCustomerChurnRisk } = await import(
      "../../src/tools/customer-churn-risk.js"
    );
    registerCustomerChurnRisk(server as any);
  });

  it("identifies at-risk customers sorted by spend", async () => {
    const customers = [
      makeCustomer({
        name: "High Value Churning",
        totalSpend: 2000,
        orderCount: 10,
        churnRatio: 3.0,
        avgIntervalDays: 30,
        daysSinceLastOrder: 90,
        lastOrderDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      }),
      makeCustomer({
        name: "Low Value Churning",
        totalSpend: 200,
        orderCount: 3,
        churnRatio: 2.5,
        avgIntervalDays: 45,
        daysSinceLastOrder: 112,
        lastOrderDate: new Date(Date.now() - 112 * 24 * 60 * 60 * 1000),
      }),
      makeCustomer({
        name: "Healthy Customer",
        totalSpend: 1000,
        orderCount: 5,
        churnRatio: 0.5,
      }),
    ];
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const handler = server.tools.get("get_customer_churn_risk")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.data.at_risk_count).toBe(2);
    expect(parsed.data.at_risk[0].name).toBe("High Value Churning");
    expect(parsed.data.at_risk[1].name).toBe("Low Value Churning");
  });

  it("returns no-data message when no repeat customers", async () => {
    const customers = [
      makeCustomer({ orderCount: 1, churnRatio: null, avgIntervalDays: null }),
    ];
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const handler = server.tools.get("get_customer_churn_risk")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.summary).toContain("repeat purchases");
    expect(parsed.data.at_risk).toHaveLength(0);
  });

  it("returns healthy message when no at-risk customers", async () => {
    const customers = [
      makeCustomer({ orderCount: 5, churnRatio: 0.5 }),
      makeCustomer({ orderCount: 3, churnRatio: 1.2 }),
    ];
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const handler = server.tools.get("get_customer_churn_risk")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.summary).toContain("No customers at churn risk");
  });

  it("respects limit parameter", async () => {
    const customers = Array.from({ length: 10 }, (_, i) =>
      makeCustomer({
        name: `Churning ${i}`,
        orderCount: 3,
        churnRatio: 2.5,
        totalSpend: 100 * (10 - i),
        avgIntervalDays: 30,
        daysSinceLastOrder: 90,
        lastOrderDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      })
    );
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const handler = server.tools.get("get_customer_churn_risk")!;
    const result = await handler({ limit: 3 });
    const parsed = parseToolResult(result);

    expect(parsed.data.at_risk).toHaveLength(3);
  });
});

// ── LTV Summary Tool Tests ─────────────────────────────

describe("get_customer_ltv_summary", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    const { registerCustomerLtvSummary } = await import(
      "../../src/tools/customer-ltv-summary.js"
    );
    registerCustomerLtvSummary(server as any);
  });

  it("returns top 10 by LTV with segment breakdown", async () => {
    const customers = Array.from({ length: 25 }, (_, i) =>
      makeCustomer({
        name: `Customer ${i}`,
        email: `c${i}@test.com`,
        annualizedLTV: 1000 * (25 - i),
        totalSpend: 500 * (25 - i),
        segment: i < 5 ? "Champions" : "Loyal",
        ltvConfidence: i < 3 ? "low" : "high",
      })
    );
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const handler = server.tools.get("get_customer_ltv_summary")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.data.top_by_ltv).toHaveLength(10);
    expect(parsed.data.top_by_ltv[0].name).toBe("Customer 0");
    expect(parsed.data.by_segment).toBeDefined();
    expect(parsed.data.low_confidence_count).toBe(3);
    expect(parsed.summary).toContain("low-confidence");
  });

  it("handles empty result", async () => {
    mockGetCustomerAnalytics.mockResolvedValue(
      makeAnalytics([], { totalCustomers: 0 })
    );

    const handler = server.tools.get("get_customer_ltv_summary")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.summary).toContain("No customers found");
  });
});

// ── Health Report Tool Tests ───────────────────────────

describe("get_customer_health_report", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    const { registerCustomerHealthReport } = await import(
      "../../src/tools/customer-health-report.js"
    );
    registerCustomerHealthReport(server as any);
  });

  it("returns full report with findings", async () => {
    const customers = Array.from({ length: 50 }, (_, i) => {
      const isAtRisk = i >= 40;
      return makeCustomer({
        name: `Customer ${i}`,
        email: `c${i}@test.com`,
        totalSpend: 100 * (50 - i),
        orderCount: isAtRisk ? 5 : i < 10 ? 1 : 3,
        segment: i < 10 ? "Champions" : i < 30 ? "Loyal" : isAtRisk ? "At Risk" : "Promising",
        churnRatio: isAtRisk ? 3.0 : 0.5,
        avgIntervalDays: 30,
        daysSinceLastOrder: isAtRisk ? 90 : 10,
        lastOrderDate: new Date(
          Date.now() - (isAtRisk ? 90 : 10) * 24 * 60 * 60 * 1000
        ),
      });
    });
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const handler = server.tools.get("get_customer_health_report")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.data.total_customers).toBe(50);
    expect(parsed.data.findings.length).toBeGreaterThan(0);
    expect(parsed.data.segments).toBeDefined();
    expect(parsed.data.revenue_concentration).toBeDefined();
    expect(parsed.data.churn_risk).toBeDefined();
    expect(parsed.data.repeat_purchase).toBeDefined();
  });

  it("returns simplified report for small store", async () => {
    const customers = Array.from({ length: 5 }, (_, i) =>
      makeCustomer({
        name: `Customer ${i}`,
        orderCount: i < 2 ? 2 : 1,
      })
    );
    mockGetCustomerAnalytics.mockResolvedValue(makeAnalytics(customers));

    const handler = server.tools.get("get_customer_health_report")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.summary).toContain("early-stage");
    expect(parsed.data.total_customers).toBe(5);
  });

  it("handles empty result", async () => {
    mockGetCustomerAnalytics.mockResolvedValue(
      makeAnalytics([], { totalCustomers: 0 })
    );

    const handler = server.tools.get("get_customer_health_report")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.summary).toContain("No customers found");
  });

  it("returns partial results when API errors occur", async () => {
    // This tests that the health report doesn't crash if getCustomerAnalytics throws
    mockGetCustomerAnalytics.mockRejectedValue(new Error("API failure"));

    const handler = server.tools.get("get_customer_health_report")!;
    const result = await handler({});
    const parsed = parseToolResult(result);

    expect(parsed.error).toBeDefined();
  });
});
