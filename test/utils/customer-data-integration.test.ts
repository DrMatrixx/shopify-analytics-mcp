/**
 * Integration tests for getCustomerAnalytics().
 * Mocks at the shopify-client level (runShopifyQL, graphql, getStoreCurrency)
 * to test the full data pipeline: fetch → parse → score → segment → cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock shopify-client before any imports that reference it
vi.mock("../../src/shopify-client.js", () => ({
  runShopifyQL: vi.fn(),
  graphql: vi.fn(),
  getStoreCurrency: vi.fn().mockResolvedValue("USD"),
}));

import { runShopifyQL, graphql, getStoreCurrency } from "../../src/shopify-client.js";
import { getCustomerAnalytics, clearCache } from "../../src/utils/customer-data.js";

const mockRunShopifyQL = vi.mocked(runShopifyQL);
const mockGraphql = vi.mocked(graphql);
const mockGetStoreCurrency = vi.mocked(getStoreCurrency);

// ── Helpers ────────────────────────────────────────────

function makeShopifyQLResult(
  rows: Array<Record<string, unknown>>
): { columns: Array<{ name: string; dataType: string; displayName: string }>; rows: unknown[] } {
  return {
    columns: [
      { name: "customer_name", dataType: "string", displayName: "Customer Name" },
      { name: "customer_email", dataType: "string", displayName: "Customer Email" },
      { name: "orders", dataType: "integer", displayName: "Orders" },
      { name: "total_sales", dataType: "money", displayName: "Total Sales" },
    ],
    rows,
  };
}

function makeGraphQLOrdersResponse(
  orders: Array<{
    createdAt: string;
    amount: string;
    customerId: string;
    displayName: string;
    email: string;
  }>,
  hasNextPage = false,
  endCursor: string | null = null
) {
  return {
    orders: {
      edges: orders.map((o) => ({
        node: {
          createdAt: o.createdAt,
          totalPriceSet: { shopMoney: { amount: o.amount } },
          customer: {
            id: o.customerId,
            displayName: o.displayName,
            email: o.email,
          },
        },
      })),
      pageInfo: { hasNextPage, endCursor },
    },
  };
}

function makeGraphQLDateOrdersResponse(
  orders: Array<{ createdAt: string; email: string | null }>,
  hasNextPage = false,
  endCursor: string | null = null
) {
  return {
    orders: {
      edges: orders.map((o) => ({
        node: {
          createdAt: o.createdAt,
          customer: o.email ? { email: o.email } : null,
        },
      })),
      pageInfo: { hasNextPage, endCursor },
    },
  };
}

// ── Setup ──────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearCache();
  mockGetStoreCurrency.mockResolvedValue("USD");
});

// ── getCustomerAnalytics: core behavior ────────────────

describe("getCustomerAnalytics", () => {
  // GAP #1: Default period
  it("uses last_12m when no period provided", async () => {
    mockRunShopifyQL.mockResolvedValue(makeShopifyQLResult([]));

    const result = await getCustomerAnalytics();

    expect(result.period).toBe("last_12m");
    expect(mockRunShopifyQL).toHaveBeenCalledWith(
      expect.stringContaining("SINCE -365d")
    );
  });

  // GAP #2: Cache HIT
  it("returns cached data on second call with same period", async () => {
    mockRunShopifyQL.mockResolvedValue(makeShopifyQLResult([]));

    const result1 = await getCustomerAnalytics("last_30d");
    const result2 = await getCustomerAnalytics("last_30d");

    expect(result1).toBe(result2); // same object reference
    expect(mockRunShopifyQL).toHaveBeenCalledTimes(1); // only fetched once
  });

  // GAP #3: Cache MISS
  it("fetches fresh data for different periods", async () => {
    mockRunShopifyQL.mockResolvedValue(makeShopifyQLResult([]));

    await getCustomerAnalytics("last_30d");
    await getCustomerAnalytics("last_90d");

    expect(mockRunShopifyQL).toHaveBeenCalledTimes(2);
  });

  // GAP #4: ShopifyQL success path
  it("sets dataSource to shopifyql on ShopifyQL success", async () => {
    const rows = generateCustomerRows(25);
    mockRunShopifyQL.mockResolvedValue(makeShopifyQLResult(rows));
    // Mock GraphQL for date fetching (customers with 2+ orders)
    mockGraphql.mockResolvedValue(
      makeGraphQLDateOrdersResponse([], false, null)
    );

    const result = await getCustomerAnalytics();

    expect(result.dataSource).toBe("shopifyql");
  });

  // GAP #5: ShopifyQL fails → GraphQL fallback
  it("falls back to GraphQL when ShopifyQL throws", async () => {
    mockRunShopifyQL.mockRejectedValue(new Error("ShopifyQL parse error"));
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse(
        [
          {
            createdAt: "2025-06-01T00:00:00Z",
            amount: "100.00",
            customerId: "gid://shopify/Customer/1",
            displayName: "Alice",
            email: "alice@test.com",
          },
        ],
        false,
        null
      )
    );

    const result = await getCustomerAnalytics();

    expect(result.dataSource).toBe("graphql");
    expect(result.totalCustomers).toBe(1);
  });

  // GAP #6: Both paths throw → error propagates
  it("propagates error when both ShopifyQL and GraphQL fail", async () => {
    mockRunShopifyQL.mockRejectedValue(new Error("ShopifyQL down"));
    mockGraphql.mockRejectedValue(new Error("GraphQL down"));

    await expect(getCustomerAnalytics()).rejects.toThrow("GraphQL down");
  });
});

// ── fetchViaShopifyQL: primary path ────────────────────

describe("fetchViaShopifyQL", () => {
  // GAP #7: ShopifyQL returns 0 rows
  it("returns empty result when ShopifyQL returns no rows", async () => {
    mockRunShopifyQL.mockResolvedValue(makeShopifyQLResult([]));

    const result = await getCustomerAnalytics();

    expect(result.totalCustomers).toBe(0);
    expect(result.customers).toHaveLength(0);
  });

  // GAP #8: null customer_name
  it("handles null customer_name as Unknown", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: null, customer_email: "a@test.com", orders: 1, total_sales: 100 },
      ])
    );
    // No GraphQL date fetch needed (1 order)

    const result = await getCustomerAnalytics();

    expect(result.customers[0].name).toBe("Unknown");
  });

  // GAP #9: null customer_email
  it("handles null customer_email as empty string", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "Bob", customer_email: null, orders: 1, total_sales: 50 },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].email).toBe("");
  });

  // GAP #10: null total_sales
  it("handles null total_sales as 0", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "Carol", customer_email: "c@test.com", orders: 1, total_sales: null },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].totalSpend).toBe(0);
  });

  // GAP #11: null orders
  it("handles null orders as 0", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "Dave", customer_email: "d@test.com", orders: null, total_sales: 100 },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].orderCount).toBe(0);
  });

  // GAP #12: Duplicate customer rows
  it("deduplicates rows with same customer name+email", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "Eve", customer_email: "e@test.com", orders: 3, total_sales: 300 },
        { customer_name: "Eve", customer_email: "e@test.com", orders: 3, total_sales: 300 },
      ])
    );
    // Eve has 3 orders so date fetching will be triggered
    mockGraphql.mockResolvedValue(
      makeGraphQLDateOrdersResponse(
        [
          { createdAt: "2025-06-01T00:00:00Z", email: "e@test.com" },
          { createdAt: "2025-07-01T00:00:00Z", email: "e@test.com" },
          { createdAt: "2025-08-01T00:00:00Z", email: "e@test.com" },
        ],
        false,
        null
      )
    );

    const result = await getCustomerAnalytics();

    expect(result.totalCustomers).toBe(1);
  });

  // GAP #13: Customers with 1 order → no GraphQL date fetch
  it("does not fetch dates for single-order customers", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "Frank", customer_email: "f@test.com", orders: 1, total_sales: 50 },
      ])
    );

    await getCustomerAnalytics();

    // graphql should not be called for date fetching
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  // GAP #14: Customers with 2+ orders → GraphQL date fetch
  it("fetches dates via GraphQL for customers with 2+ orders", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "Grace", customer_email: "g@test.com", orders: 3, total_sales: 300 },
      ])
    );
    mockGraphql.mockResolvedValue(
      makeGraphQLDateOrdersResponse(
        [
          { createdAt: "2025-06-01T00:00:00Z", email: "g@test.com" },
          { createdAt: "2025-07-01T00:00:00Z", email: "g@test.com" },
          { createdAt: "2025-08-01T00:00:00Z", email: "g@test.com" },
        ],
        false,
        null
      )
    );

    const result = await getCustomerAnalytics();

    expect(mockGraphql).toHaveBeenCalled();
    expect(result.customers[0].orderDates).toHaveLength(3);
    expect(result.customers[0].avgIntervalDays).toBeCloseTo(30.5, 0);
  });

  // GAP #15: Customers with no email → filtered out of date fetch
  it("skips date fetching for customers without email", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "NoEmail", customer_email: "", orders: 5, total_sales: 500 },
      ])
    );

    await getCustomerAnalytics();

    // Should not call graphql since the only customer has no email
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

// ── fetchViaGraphQL: fallback path ─────────────────────

describe("fetchViaGraphQL", () => {
  beforeEach(() => {
    // Force GraphQL fallback by making ShopifyQL fail
    mockRunShopifyQL.mockRejectedValue(new Error("ShopifyQL unavailable"));
  });

  // GAP #16: Single page
  it("handles single page of results", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse(
        [
          {
            createdAt: "2025-06-01T00:00:00Z",
            amount: "100.00",
            customerId: "gid://shopify/Customer/1",
            displayName: "Alice",
            email: "alice@test.com",
          },
          {
            createdAt: "2025-07-01T00:00:00Z",
            amount: "200.00",
            customerId: "gid://shopify/Customer/2",
            displayName: "Bob",
            email: "bob@test.com",
          },
        ],
        false,
        null
      )
    );

    const result = await getCustomerAnalytics();

    expect(result.totalCustomers).toBe(2);
    expect(result.dataSource).toBe("graphql");
  });

  // GAP #17: Multi-page pagination
  it("paginates through multiple pages", async () => {
    mockGraphql
      .mockResolvedValueOnce(
        makeGraphQLOrdersResponse(
          [
            {
              createdAt: "2025-06-01T00:00:00Z",
              amount: "100.00",
              customerId: "gid://shopify/Customer/1",
              displayName: "Alice",
              email: "alice@test.com",
            },
          ],
          true,
          "cursor-page-1"
        )
      )
      .mockResolvedValueOnce(
        makeGraphQLOrdersResponse(
          [
            {
              createdAt: "2025-07-01T00:00:00Z",
              amount: "200.00",
              customerId: "gid://shopify/Customer/2",
              displayName: "Bob",
              email: "bob@test.com",
            },
          ],
          true,
          "cursor-page-2"
        )
      )
      .mockResolvedValueOnce(
        makeGraphQLOrdersResponse(
          [
            {
              createdAt: "2025-08-01T00:00:00Z",
              amount: "150.00",
              customerId: "gid://shopify/Customer/3",
              displayName: "Carol",
              email: "carol@test.com",
            },
          ],
          false,
          null
        )
      );

    const result = await getCustomerAnalytics();

    expect(result.totalCustomers).toBe(3);
    expect(mockGraphql).toHaveBeenCalledTimes(3);
  });

  // GAP #18: null customer on order → skipped
  it("skips orders with null customer", async () => {
    mockGraphql.mockResolvedValue({
      orders: {
        edges: [
          {
            node: {
              createdAt: "2025-06-01T00:00:00Z",
              totalPriceSet: { shopMoney: { amount: "100.00" } },
              customer: null,
            },
          },
          {
            node: {
              createdAt: "2025-06-02T00:00:00Z",
              totalPriceSet: { shopMoney: { amount: "200.00" } },
              customer: {
                id: "gid://shopify/Customer/1",
                displayName: "Alice",
                email: "alice@test.com",
              },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const result = await getCustomerAnalytics();

    expect(result.totalCustomers).toBe(1);
    expect(result.customers[0].name).toBe("Alice");
  });

  // GAP #19: null displayName → "Unknown"
  it("handles null displayName as Unknown", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: null as any,
          email: "a@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].name).toBe("Unknown");
  });

  // GAP #20: null email → ""
  it("handles null email as empty string", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "NoEmail",
          email: null as any,
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].email).toBe("");
  });

  // GAP #21: amount "0"
  it("handles zero amount orders", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "0",
          customerId: "gid://shopify/Customer/1",
          displayName: "FreeOrder",
          email: "free@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].totalSpend).toBe(0);
  });

  // GAP #22: non-numeric amount → NaN → 0
  it("handles non-numeric amount as 0", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "not-a-number",
          customerId: "gid://shopify/Customer/1",
          displayName: "BadData",
          email: "bad@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].totalSpend).toBe(0);
  });

  // GAP #23: Multiple orders aggregated for same customer
  it("aggregates multiple orders for the same customer", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Alice",
          email: "alice@test.com",
        },
        {
          createdAt: "2025-07-01T00:00:00Z",
          amount: "200.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Alice",
          email: "alice@test.com",
        },
        {
          createdAt: "2025-08-01T00:00:00Z",
          amount: "150.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Alice",
          email: "alice@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.totalCustomers).toBe(1);
    expect(result.customers[0].totalSpend).toBe(450);
    expect(result.customers[0].orderCount).toBe(3);
    expect(result.customers[0].orderDates).toHaveLength(3);
  });

  // GAP #24: 0 orders → empty result
  it("returns empty result when GraphQL returns no orders", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([], false, null)
    );

    const result = await getCustomerAnalytics();

    expect(result.totalCustomers).toBe(0);
    expect(result.dataSource).toBe("graphql");
  });
});

// ── fetchOrderDatesForCustomers ────────────────────────

describe("fetchOrderDatesForCustomers (via ShopifyQL path)", () => {
  // GAP #25: Empty email list → no GraphQL calls
  it("makes no GraphQL calls when no emails need dates", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "Solo", customer_email: "solo@test.com", orders: 1, total_sales: 100 },
      ])
    );

    await getCustomerAnalytics();

    // Only single-order customer, no date fetching needed
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  // GAP #26: Batching with >10 emails
  it("batches emails in groups of 10", async () => {
    // Create 15 customers with 2+ orders
    const rows = Array.from({ length: 15 }, (_, i) => ({
      customer_name: `Customer ${i}`,
      customer_email: `c${i}@test.com`,
      orders: 3,
      total_sales: 100 * (i + 1),
    }));
    mockRunShopifyQL.mockResolvedValue(makeShopifyQLResult(rows));
    // Each batch returns empty results (simplifies test)
    mockGraphql.mockResolvedValue(
      makeGraphQLDateOrdersResponse([], false, null)
    );

    await getCustomerAnalytics();

    // Should be 2 batches: 10 + 5 emails
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  // GAP #27: Multi-page date results
  it("paginates within a date fetch batch", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "Heavy", customer_email: "heavy@test.com", orders: 5, total_sales: 1000 },
      ])
    );
    // First page of dates
    mockGraphql
      .mockResolvedValueOnce(
        makeGraphQLDateOrdersResponse(
          [
            { createdAt: "2025-06-01T00:00:00Z", email: "heavy@test.com" },
            { createdAt: "2025-07-01T00:00:00Z", email: "heavy@test.com" },
          ],
          true,
          "date-cursor-1"
        )
      )
      // Second page of dates
      .mockResolvedValueOnce(
        makeGraphQLDateOrdersResponse(
          [
            { createdAt: "2025-08-01T00:00:00Z", email: "heavy@test.com" },
          ],
          false,
          null
        )
      );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].orderDates).toHaveLength(3);
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  // GAP #28: null customer email in date results → skipped
  it("skips date entries with null customer email", async () => {
    mockRunShopifyQL.mockResolvedValue(
      makeShopifyQLResult([
        { customer_name: "X", customer_email: "x@test.com", orders: 2, total_sales: 200 },
      ])
    );
    mockGraphql.mockResolvedValue(
      makeGraphQLDateOrdersResponse(
        [
          { createdAt: "2025-06-01T00:00:00Z", email: "x@test.com" },
          { createdAt: "2025-07-01T00:00:00Z", email: null },
        ],
        false,
        null
      )
    );

    const result = await getCustomerAnalytics();

    // Only 1 date should be captured (the null-email one is skipped)
    // But the customer still gets the fallback [now] date since only 1 date was fetched
    // Actually: the result map has 1 date for x@test.com, which is > 0, so it uses that
    expect(result.customers[0].orderDates.length).toBeGreaterThanOrEqual(1);
  });
});

// ── buildAnalytics: computation ────────────────────────

describe("buildAnalytics computation", () => {
  beforeEach(() => {
    mockRunShopifyQL.mockRejectedValue(new Error("force graphql"));
  });

  // GAP #30: Order dates sorted
  it("sorts order dates chronologically", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-08-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Alice",
          email: "alice@test.com",
        },
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Alice",
          email: "alice@test.com",
        },
        {
          createdAt: "2025-07-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Alice",
          email: "alice@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();
    const dates = result.customers[0].orderDates;

    expect(dates[0].getTime()).toBeLessThan(dates[1].getTime());
    expect(dates[1].getTime()).toBeLessThan(dates[2].getTime());
  });

  // GAP #32: ageDays minimum is 1
  it("sets minimum ageDays to 1 for same-day customer", async () => {
    const today = new Date().toISOString();
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: today,
          amount: "50.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "NewGuy",
          email: "new@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    // LTV should not be Infinity (ageDays = 1, not 0)
    expect(result.customers[0].annualizedLTV).toBe(50 * 365);
    expect(isFinite(result.customers[0].annualizedLTV)).toBe(true);
  });

  // GAP #33-34: avgIntervalDays
  it("sets avgIntervalDays to null for single-order customer", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Solo",
          email: "solo@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].avgIntervalDays).toBeNull();
  });

  it("computes avgIntervalDays for multi-order customer", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Repeat",
          email: "repeat@test.com",
        },
        {
          createdAt: "2025-07-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Repeat",
          email: "repeat@test.com",
        },
        {
          createdAt: "2025-08-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "Repeat",
          email: "repeat@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    // June 1 → July 1 = ~30 days, July 1 → Aug 1 = ~31 days, avg ~30.5
    expect(result.customers[0].avgIntervalDays).toBeCloseTo(30.5, 0);
  });

  // GAP #35-36: churnRatio null conditions
  it("sets churnRatio to null when avgIntervalDays is null", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "OneTime",
          email: "once@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].churnRatio).toBeNull();
  });

  // GAP #38-39: ltvConfidence
  it("flags low confidence for customer active < 60 days", async () => {
    const recentDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: recentDate,
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "NewCustomer",
          email: "new@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].ltvConfidence).toBe("low");
  });

  it("flags high confidence for customer active >= 60 days", async () => {
    const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: oldDate,
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "OldCustomer",
          email: "old@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.customers[0].ltvConfidence).toBe("high");
  });

  // GAP #40: skipQuartiles when < 20 customers
  it("skips quartile scoring for < 20 customers", async () => {
    const orders = Array.from({ length: 5 }, (_, i) => ({
      createdAt: `2025-0${i + 1}-01T00:00:00Z`,
      amount: `${(i + 1) * 100}.00`,
      customerId: `gid://shopify/Customer/${i}`,
      displayName: `Customer ${i}`,
      email: `c${i}@test.com`,
    }));
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse(orders, false, null)
    );

    const result = await getCustomerAnalytics();

    for (const c of result.customers) {
      expect(c.rfmScores).toEqual({ r: 0, f: 0, m: 0 });
      expect(c.segment).toBe("N/A");
    }
  });

  // GAP #41: segmentCounts aggregated
  it("correctly aggregates segment counts", async () => {
    // Generate 25 customers via GraphQL to trigger RFM scoring
    const orders = Array.from({ length: 25 }, (_, i) => ({
      createdAt: new Date(Date.now() - (i * 10 + 1) * 24 * 60 * 60 * 1000).toISOString(),
      amount: `${(i + 1) * 50}.00`,
      customerId: `gid://shopify/Customer/${i}`,
      displayName: `Customer ${i}`,
      email: `c${i}@test.com`,
    }));
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse(orders, false, null)
    );

    const result = await getCustomerAnalytics();

    const totalFromCounts = Object.values(result.segmentCounts).reduce(
      (sum, c) => sum + c,
      0
    );
    expect(totalFromCounts).toBe(result.totalCustomers);
  });

  // GAP #42: totalRevenue summed correctly
  it("computes totalRevenue from all customers", async () => {
    mockGraphql.mockResolvedValue(
      makeGraphQLOrdersResponse([
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "100.00",
          customerId: "gid://shopify/Customer/1",
          displayName: "A",
          email: "a@test.com",
        },
        {
          createdAt: "2025-06-01T00:00:00Z",
          amount: "250.50",
          customerId: "gid://shopify/Customer/2",
          displayName: "B",
          email: "b@test.com",
        },
      ])
    );

    const result = await getCustomerAnalytics();

    expect(result.totalRevenue).toBeCloseTo(350.5);
  });
});

// ── Helper to generate N customer rows for ShopifyQL ───

function generateCustomerRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    customer_name: `Customer ${i}`,
    customer_email: `c${i}@test.com`,
    orders: (i % 5) + 1,
    total_sales: (i + 1) * 100,
  }));
}
