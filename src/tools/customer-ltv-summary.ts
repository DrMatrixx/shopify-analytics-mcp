import { z } from "zod";
import { getCustomerAnalytics } from "../utils/customer-data.js";
import { formatMoney, formatNumber, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCustomerLtvSummary(server: McpServer) {
  server.tool(
    "get_customer_ltv_summary",
    "Get customer lifetime value (LTV) projections. Shows annualized revenue run-rate per customer, top customers by projected LTV, and LTV breakdown by RFM segment.",
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
            summary: `No customers found for the requested period (${period ?? "last 12 months"}).`,
            data: { period: period ?? "last_12m", top_by_ltv: [], by_segment: {} },
          });
        }

        const { customers, currency } = analytics;

        // Top 10 by projected LTV
        const sortedByLtv = [...customers].sort(
          (a, b) => b.annualizedLTV - a.annualizedLTV
        );
        const top10 = sortedByLtv.slice(0, 10).map((c) => ({
          name: c.name,
          email: c.email,
          projected_annual_ltv: formatMoney(c.annualizedLTV, currency),
          projected_annual_ltv_raw: Math.round(c.annualizedLTV * 100) / 100,
          actual_spend: formatMoney(c.totalSpend, currency),
          orders: c.orderCount,
          confidence: c.ltvConfidence,
          segment: c.segment,
        }));

        // LTV by segment
        const segmentLtv: Record<
          string,
          {
            count: number;
            avg_ltv: string;
            avg_ltv_raw: number;
            total_spend: string;
            avg_orders: number;
          }
        > = {};

        const segmentGroups = new Map<string, typeof customers>();
        for (const c of customers) {
          const group = segmentGroups.get(c.segment) ?? [];
          group.push(c);
          segmentGroups.set(c.segment, group);
        }

        for (const [segment, group] of segmentGroups) {
          const avgLtv =
            group.reduce((sum, c) => sum + c.annualizedLTV, 0) / group.length;
          const totalSpend = group.reduce((sum, c) => sum + c.totalSpend, 0);
          const avgOrders =
            group.reduce((sum, c) => sum + c.orderCount, 0) / group.length;

          segmentLtv[segment] = {
            count: group.length,
            avg_ltv: formatMoney(avgLtv, currency),
            avg_ltv_raw: Math.round(avgLtv * 100) / 100,
            total_spend: formatMoney(totalSpend, currency),
            avg_orders: Math.round(avgOrders * 10) / 10,
          };
        }

        // Distribution stats
        const ltvValues = customers.map((c) => c.annualizedLTV);
        const sorted = [...ltvValues].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const avg =
          ltvValues.reduce((sum, v) => sum + v, 0) / ltvValues.length;

        const lowConfidenceCount = customers.filter(
          (c) => c.ltvConfidence === "low"
        ).length;

        let summary = `Customer LTV summary (${period ?? "last 12 months"}): ${formatNumber(analytics.totalCustomers)} customers analyzed. Average projected LTV: ${formatMoney(avg, currency)}, median: ${formatMoney(median, currency)}.`;

        if (top10.length > 0) {
          summary += ` Top customer: ${top10[0].name} (projected ${top10[0].projected_annual_ltv}/year).`;
        }

        if (lowConfidenceCount > 0) {
          summary += ` ${formatNumber(lowConfidenceCount)} projections are low-confidence (customer active < 60 days).`;
        }

        return toolResult({
          summary,
          data: {
            period: period ?? "last_12m",
            total_customers: analytics.totalCustomers,
            avg_ltv: formatMoney(avg, currency),
            median_ltv: formatMoney(median, currency),
            low_confidence_count: lowConfidenceCount,
            top_by_ltv: top10,
            by_segment: segmentLtv,
          },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
