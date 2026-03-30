import { z } from "zod";
import { getCustomerAnalytics } from "../utils/customer-data.js";
import { formatMoney, formatNumber, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCustomerRfmSegments(server: McpServer) {
  server.tool(
    "get_customer_rfm_segments",
    "Segment customers by Recency, Frequency, and Monetary value (RFM analysis). Identifies Champions, Loyal, At Risk, Lost, and other segments.",
    {
      period: z
        .string()
        .optional()
        .describe(
          "Date range for analysis (default: last_12m). Supports: last_7d, last_30d, last_90d, last_12m, this_year, last_year, or YYYY-MM-DD:YYYY-MM-DD"
        ),
    },
    async ({ period }) => {
      try {
        const analytics = await getCustomerAnalytics(period);

        if (analytics.totalCustomers === 0) {
          return toolResult({
            summary: `No customers found for the requested period (${period ?? "last 12 months"}). This could mean no orders were placed in this timeframe.`,
            data: { period: period ?? "last_12m", segments: {}, customers: [] },
          });
        }

        const { customers, segmentCounts, currency } = analytics;
        const skipQuartiles = analytics.totalCustomers < 20;

        if (skipQuartiles) {
          const sorted = [...customers].sort(
            (a, b) => b.totalSpend - a.totalSpend
          );
          const customerList = sorted.map((c) => ({
            name: c.name,
            email: c.email,
            total_spend: c.totalSpend,
            orders: c.orderCount,
            days_since_last_order: c.daysSinceLastOrder,
          }));

          return toolResult({
            summary: `${formatNumber(analytics.totalCustomers)} customers found (${period ?? "last 12 months"}). Too few customers for meaningful segmentation (need 20+). Here are all customers sorted by spend.`,
            data: {
              period: period ?? "last_12m",
              note: "Fewer than 20 customers — showing raw data instead of segments",
              customers: customerList,
            },
          });
        }

        // Build segment breakdown with top customers per segment
        const segmentBreakdown: Record<
          string,
          {
            count: number;
            percentage: string;
            top_customers: Array<{
              name: string;
              email: string;
              total_spend: string;
              orders: number;
            }>;
          }
        > = {};

        for (const [segment, count] of Object.entries(segmentCounts)) {
          const pct = ((count / analytics.totalCustomers) * 100).toFixed(1);
          const segmentCustomers = customers
            .filter((c) => c.segment === segment)
            .sort((a, b) => b.totalSpend - a.totalSpend)
            .slice(0, 3)
            .map((c) => ({
              name: c.name,
              email: c.email,
              total_spend: formatMoney(c.totalSpend, currency),
              orders: c.orderCount,
            }));

          segmentBreakdown[segment] = {
            count,
            percentage: `${pct}%`,
            top_customers: segmentCustomers,
          };
        }

        // Build summary
        const segmentList = Object.entries(segmentCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([seg, count]) => `${seg}: ${count}`)
          .join(", ");

        const champCount = segmentCounts["Champions"] ?? 0;
        const atRiskCount = segmentCounts["At Risk"] ?? 0;
        const lostCount = segmentCounts["Lost"] ?? 0;

        let summary = `Customer RFM segments (${period ?? "last 12 months"}): ${formatNumber(analytics.totalCustomers)} customers analyzed. ${segmentList}.`;

        if (champCount > 0) {
          summary += ` ${champCount} Champions (your best customers).`;
        }
        if (atRiskCount > 0) {
          summary += ` ${atRiskCount} At Risk (were loyal, haven't bought recently).`;
        }
        if (lostCount > 0) {
          summary += ` ${lostCount} Lost (inactive, low engagement).`;
        }

        return toolResult({
          summary,
          data: {
            period: period ?? "last_12m",
            total_customers: analytics.totalCustomers,
            total_revenue: formatMoney(analytics.totalRevenue, currency),
            segments: segmentBreakdown,
          },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
