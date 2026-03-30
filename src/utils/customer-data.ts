import { runShopifyQL, graphql, getStoreCurrency } from "../shopify-client.js";
import { tableToObjects } from "./formatters.js";
import { periodToClause } from "./shopifyql-helpers.js";

// ── Types ──────────────────────────────────────────────

export interface CustomerRecord {
  name: string;
  email: string;
  totalSpend: number;
  orderCount: number;
  firstOrderDate: Date;
  lastOrderDate: Date;
  orderDates: Date[];
  avgIntervalDays: number | null;
  daysSinceLastOrder: number;
  rfmScores: { r: number; f: number; m: number };
  segment: string;
  churnRatio: number | null;
  annualizedLTV: number;
  ltvConfidence: "high" | "low";
}

export interface CustomerAnalytics {
  customers: CustomerRecord[];
  segmentCounts: Record<string, number>;
  totalCustomers: number;
  totalRevenue: number;
  period: string;
  dataSource: "shopifyql" | "graphql";
  currency: string;
}

// ── Segment definitions (evaluated top-to-bottom, first match wins) ──

interface SegmentRule {
  name: string;
  r: [number, number];
  f: [number, number];
  m: [number, number];
}

const SEGMENT_RULES: SegmentRule[] = [
  { name: "Champions", r: [4, 4], f: [3, 4], m: [3, 4] },
  { name: "Loyal", r: [2, 4], f: [3, 4], m: [3, 4] },
  { name: "Promising", r: [3, 4], f: [1, 2], m: [1, 2] },
  { name: "At Risk", r: [1, 2], f: [3, 4], m: [3, 4] },
  { name: "Hibernating", r: [1, 2], f: [1, 2], m: [2, 4] },
  { name: "Lost", r: [1, 1], f: [1, 1], m: [1, 2] },
];

// ── Cache ──────────────────────────────────────────────

const cache = new Map<string, CustomerAnalytics>();

function normalizePeriodKey(period: string): string {
  // Convert period to a ShopifyQL clause to get a canonical form
  const clause = periodToClause(period);
  return clause;
}

export function clearCache(): void {
  cache.clear();
}

// ── Main entry point ───────────────────────────────────

export async function getCustomerAnalytics(
  period?: string
): Promise<CustomerAnalytics> {
  const effectivePeriod = period ?? "last_12m";
  const cacheKey = normalizePeriodKey(effectivePeriod);

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const currency = await getStoreCurrency();
  let result: CustomerAnalytics;

  try {
    result = await fetchViaShopifyQL(effectivePeriod, currency);
  } catch {
    result = await fetchViaGraphQL(effectivePeriod, currency);
  }

  cache.set(cacheKey, result);
  return result;
}

// ── ShopifyQL primary path ─────────────────────────────

async function fetchViaShopifyQL(
  period: string,
  currency: string
): Promise<CustomerAnalytics> {
  const dateClause = periodToClause(period);
  const query = `FROM sales SHOW customer_name, customer_email, orders, total_sales GROUP BY customer_name, customer_email ${dateClause} ORDER BY total_sales DESC`;

  const rawResult = await runShopifyQL(query);
  const rows = tableToObjects(rawResult);

  if (rows.length === 0) {
    return buildEmptyResult(period, "shopifyql", currency);
  }

  // ShopifyQL gives us aggregates but not individual order dates.
  // We need order dates for inter-purchase interval calculation.
  // Fetch dates via GraphQL for the top customers (by spend).
  const customerMap = new Map<
    string,
    { name: string; email: string; totalSpend: number; orderCount: number }
  >();

  for (const row of rows) {
    const name = (row.customer_name as string) ?? "Unknown";
    const email = (row.customer_email as string) ?? "";
    const key = `${name}|${email}`;

    if (!customerMap.has(key)) {
      customerMap.set(key, {
        name,
        email,
        totalSpend: (row.total_sales as number) ?? 0,
        orderCount: (row.orders as number) ?? 0,
      });
    }
  }

  // Fetch order dates via GraphQL for customers with 2+ orders
  const customersNeedingDates = Array.from(customerMap.values()).filter(
    (c) => c.orderCount >= 2
  );

  const orderDateMap = await fetchOrderDatesForCustomers(
    customersNeedingDates.map((c) => c.email).filter(Boolean),
    period
  );

  const now = new Date();
  const rawCustomers: Array<{
    name: string;
    email: string;
    totalSpend: number;
    orderCount: number;
    orderDates: Date[];
  }> = [];

  for (const [, c] of customerMap) {
    const dates = orderDateMap.get(c.email) ?? [];
    rawCustomers.push({
      ...c,
      orderDates: dates.length > 0 ? dates : [now], // fallback if no dates fetched
    });
  }

  return buildAnalytics(rawCustomers, period, "shopifyql", currency);
}

// ── GraphQL fallback path ──────────────────────────────

interface OrderNode {
  createdAt: string;
  totalPriceSet: { shopMoney: { amount: string } };
  customer: { id: string; displayName: string; email: string } | null;
}

async function fetchViaGraphQL(
  period: string,
  currency: string
): Promise<CustomerAnalytics> {
  const startDate = periodToStartDate(period);
  const queryStr = `
    query ($cursor: String) {
      orders(first: 250, after: $cursor, query: "created_at:>=${startDate}") {
        edges {
          node {
            createdAt
            totalPriceSet { shopMoney { amount } }
            customer { id displayName email }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const customerMap = new Map<
    string,
    {
      name: string;
      email: string;
      totalSpend: number;
      orderCount: number;
      orderDates: Date[];
    }
  >();

  let orderCursor: string | null = null;
  let hasMoreOrders = true;

  interface OrdersResponse {
    orders: {
      edges: Array<{ node: OrderNode }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }

  while (hasMoreOrders) {
    const resp: OrdersResponse = await graphql<OrdersResponse>(queryStr, {
      cursor: orderCursor,
    });

    for (const edge of resp.orders.edges) {
      const order = edge.node;
      const customer = order.customer;
      if (!customer) continue;

      const key = customer.id;
      const amount = parseFloat(order.totalPriceSet.shopMoney.amount) || 0;
      const date = new Date(order.createdAt);

      const existing = customerMap.get(key);
      if (existing) {
        existing.totalSpend += amount;
        existing.orderCount += 1;
        existing.orderDates.push(date);
      } else {
        customerMap.set(key, {
          name: customer.displayName ?? "Unknown",
          email: customer.email ?? "",
          totalSpend: amount,
          orderCount: 1,
          orderDates: [date],
        });
      }
    }

    hasMoreOrders = resp.orders.pageInfo.hasNextPage;
    orderCursor = resp.orders.pageInfo.endCursor;
  }

  if (customerMap.size === 0) {
    return buildEmptyResult(period, "graphql", currency);
  }

  return buildAnalytics(
    Array.from(customerMap.values()),
    period,
    "graphql",
    currency
  );
}

// ── Fetch order dates for specific customers ───────────

async function fetchOrderDatesForCustomers(
  emails: string[],
  period: string
): Promise<Map<string, Date[]>> {
  const result = new Map<string, Date[]>();
  if (emails.length === 0) return result;

  const startDate = periodToStartDate(period);

  // Batch by email — fetch orders for up to 50 customers at a time
  const batchSize = 10;
  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);
    const emailFilter = batch.map((e) => `email:${e}`).join(" OR ");

    let dateCursor: string | null = null;
    let hasMoreDates = true;

    interface DateOrdersResponse {
      orders: {
        edges: Array<{
          node: {
            createdAt: string;
            customer: { email: string } | null;
          };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }

    while (hasMoreDates) {
      const resp: DateOrdersResponse = await graphql<DateOrdersResponse>(
        `query ($cursor: String) {
          orders(first: 250, after: $cursor, query: "(${emailFilter}) created_at:>=${startDate}") {
            edges {
              node {
                createdAt
                customer { email }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { cursor: dateCursor }
      );

      for (const edge of resp.orders.edges) {
        const email = edge.node.customer?.email;
        if (!email) continue;
        const dates = result.get(email) ?? [];
        dates.push(new Date(edge.node.createdAt));
        result.set(email, dates);
      }

      hasMoreDates = resp.orders.pageInfo.hasNextPage;
      dateCursor = resp.orders.pageInfo.endCursor;
    }
  }

  return result;
}

// ── Build analytics from raw customer data ─────────────

function buildAnalytics(
  rawCustomers: Array<{
    name: string;
    email: string;
    totalSpend: number;
    orderCount: number;
    orderDates: Date[];
  }>,
  period: string,
  dataSource: "shopifyql" | "graphql",
  currency: string
): CustomerAnalytics {
  const now = new Date();
  const skipQuartiles = rawCustomers.length < 20;

  // Sort order dates for each customer
  for (const c of rawCustomers) {
    c.orderDates.sort((a, b) => a.getTime() - b.getTime());
  }

  // Compute raw metrics
  const metrics = rawCustomers.map((c) => {
    const firstOrder = c.orderDates[0];
    const lastOrder = c.orderDates[c.orderDates.length - 1];
    const daysSinceLast = Math.floor(
      (now.getTime() - lastOrder.getTime()) / (1000 * 60 * 60 * 24)
    );
    const ageDays = Math.max(
      1,
      Math.floor(
        (now.getTime() - firstOrder.getTime()) / (1000 * 60 * 60 * 24)
      )
    );

    let avgIntervalDays: number | null = null;
    if (c.orderDates.length >= 2) {
      let totalInterval = 0;
      for (let i = 1; i < c.orderDates.length; i++) {
        totalInterval +=
          (c.orderDates[i].getTime() - c.orderDates[i - 1].getTime()) /
          (1000 * 60 * 60 * 24);
      }
      avgIntervalDays = totalInterval / (c.orderDates.length - 1);
    }

    const churnRatio =
      avgIntervalDays !== null && avgIntervalDays > 0
        ? daysSinceLast / avgIntervalDays
        : null;

    const annualizedLTV = (c.totalSpend / ageDays) * 365;
    const ltvConfidence: "high" | "low" = ageDays < 60 ? "low" : "high";

    return {
      ...c,
      firstOrderDate: firstOrder,
      lastOrderDate: lastOrder,
      daysSinceLastOrder: daysSinceLast,
      avgIntervalDays,
      churnRatio,
      annualizedLTV,
      ltvConfidence,
      ageDays,
    };
  });

  // Compute RFM scores
  const recencies = metrics.map((m) => m.daysSinceLastOrder);
  const frequencies = metrics.map((m) => m.orderCount);
  const monetaries = metrics.map((m) => m.totalSpend);

  const customers: CustomerRecord[] = metrics.map((m) => {
    const r = skipQuartiles
      ? 0
      : computeQuartile(m.daysSinceLastOrder, recencies, true); // reversed: lower days = higher score
    const f = skipQuartiles
      ? 0
      : computeQuartile(m.orderCount, frequencies, false);
    const mScore = skipQuartiles
      ? 0
      : computeQuartile(m.totalSpend, monetaries, false);

    const segment = skipQuartiles
      ? "N/A"
      : assignSegment(r, f, mScore);

    return {
      name: m.name,
      email: m.email,
      totalSpend: m.totalSpend,
      orderCount: m.orderCount,
      firstOrderDate: m.firstOrderDate,
      lastOrderDate: m.lastOrderDate,
      orderDates: m.orderDates,
      avgIntervalDays: m.avgIntervalDays,
      daysSinceLastOrder: m.daysSinceLastOrder,
      rfmScores: { r, f, m: mScore },
      segment,
      churnRatio: m.churnRatio,
      annualizedLTV: m.annualizedLTV,
      ltvConfidence: m.ltvConfidence,
    };
  });

  // Count segments
  const segmentCounts: Record<string, number> = {};
  for (const c of customers) {
    segmentCounts[c.segment] = (segmentCounts[c.segment] ?? 0) + 1;
  }

  const totalRevenue = customers.reduce((sum, c) => sum + c.totalSpend, 0);

  return {
    customers,
    segmentCounts,
    totalCustomers: customers.length,
    totalRevenue,
    period,
    dataSource,
    currency,
  };
}

function buildEmptyResult(
  period: string,
  dataSource: "shopifyql" | "graphql",
  currency: string
): CustomerAnalytics {
  return {
    customers: [],
    segmentCounts: {},
    totalCustomers: 0,
    totalRevenue: 0,
    period,
    dataSource,
    currency,
  };
}

// ── RFM scoring helpers ────────────────────────────────

export function computeQuartile(
  value: number,
  allValues: number[],
  reversed: boolean
): number {
  const sorted = [...allValues].sort((a, b) => a - b);

  // If all values are identical, assign score 2 (neutral)
  if (sorted[0] === sorted[sorted.length - 1]) return 2;

  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q2 = sorted[Math.floor(sorted.length * 0.5)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];

  let score: number;
  if (value <= q1) score = 1;
  else if (value <= q2) score = 2;
  else if (value <= q3) score = 3;
  else score = 4;

  // For recency, lower days = better = higher score
  if (reversed) score = 5 - score;

  return score;
}

export function assignSegment(r: number, f: number, m: number): string {
  for (const rule of SEGMENT_RULES) {
    if (
      r >= rule.r[0] &&
      r <= rule.r[1] &&
      f >= rule.f[0] &&
      f <= rule.f[1] &&
      m >= rule.m[0] &&
      m <= rule.m[1]
    ) {
      return rule.name;
    }
  }
  return "Needs Attention";
}

// ── Date helpers ───────────────────────────────────────

function periodToStartDate(period: string): string {
  const now = new Date();

  const daysMatch = period.match(/^last_(\d+)d$/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return start.toISOString().split("T")[0];
  }

  // Handle named periods
  const periodMap: Record<string, number> = {
    last_7d: 7,
    last_30d: 30,
    last_90d: 90,
    last_12m: 365,
    last_year: 365,
    this_year: Math.floor(
      (now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) /
        (1000 * 60 * 60 * 24)
    ),
  };

  const days = periodMap[period] ?? 365;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return start.toISOString().split("T")[0];
}
