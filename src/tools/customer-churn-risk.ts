import { z } from "zod";
import { getCustomerAnalytics } from "../utils/customer-data.js";
import { formatMoney, formatNumber, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCustomerChurnRisk(server: McpServer) {
  server.tool(
    "get_customer_churn_risk",
    "Identify customers at risk of churning based on their purchase patterns. Finds customers who have gone significantly longer than usual without ordering, sorted by lifetime spend.",
    {
      period: z
        .string()
        .optional()
        .describe(
          "Date range for analysis (default: last_12m). Supports: last_7d, last_30d, last_90d, last_12m, this_year, last_year, or YYYY-MM-DD:YYYY-MM-DD"
        ),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of at-risk customers to return (default: 20)"),
    },
    async ({ period, limit }) => {
      try {
        const maxResults = limit ?? 20;
        const analytics = await getCustomerAnalytics(period);

        if (analytics.totalCustomers === 0) {
          return toolResult({
            summary: `No customers found for the requested period (${period ?? "last 12 months"}).`,
            data: { period: period ?? "last_12m", at_risk: [] },
          });
        }

        const { customers, currency } = analytics;

        // Only customers with 2+ orders can have meaningful churn analysis
        const repeatCustomers = customers.filter(
          (c) => c.orderCount >= 2 && c.churnRatio !== null
        );

        if (repeatCustomers.length === 0) {
          return toolResult({
            summary: `Churn analysis requires customers with repeat purchases. Of ${formatNumber(analytics.totalCustomers)} customers in this period, none have 2+ orders. Focus on getting first-time buyers to come back.`,
            data: {
              period: period ?? "last_12m",
              total_customers: analytics.totalCustomers,
              repeat_customers: 0,
              at_risk: [],
              note: "No repeat customers found — churn analysis requires purchase history",
            },
          });
        }

        // Filter to at-risk (churn ratio > 2.0) and sort by spend
        const atRisk = repeatCustomers
          .filter((c) => c.churnRatio! > 2.0)
          .sort((a, b) => b.totalSpend - a.totalSpend)
          .slice(0, maxResults);

        if (atRisk.length === 0) {
          return toolResult({
            summary: `No customers at churn risk (${period ?? "last 12 months"}). All ${formatNumber(repeatCustomers.length)} repeat customers are ordering within their normal patterns. Your retention is healthy.`,
            data: {
              period: period ?? "last_12m",
              total_customers: analytics.totalCustomers,
              repeat_customers: repeatCustomers.length,
              at_risk: [],
            },
          });
        }

        const totalAtRiskRevenue = atRisk.reduce(
          (sum, c) => sum + c.totalSpend,
          0
        );

        const atRiskList = atRisk.map((c) => {
          const expectedReorderDate = new Date(
            c.lastOrderDate.getTime() +
              (c.avgIntervalDays ?? 0) * 24 * 60 * 60 * 1000
          );
          const daysOverdue = Math.floor(
            (Date.now() - expectedReorderDate.getTime()) /
              (1000 * 60 * 60 * 24)
          );

          return {
            name: c.name,
            email: c.email,
            total_spend: formatMoney(c.totalSpend, currency),
            total_spend_raw: c.totalSpend,
            orders: c.orderCount,
            last_order: c.lastOrderDate.toISOString().split("T")[0],
            avg_interval_days: Math.round(c.avgIntervalDays ?? 0),
            days_since_last_order: c.daysSinceLastOrder,
            expected_reorder: expectedReorderDate.toISOString().split("T")[0],
            days_overdue: daysOverdue,
            churn_ratio: Math.round(c.churnRatio! * 10) / 10,
          };
        });

        const topAtRisk = atRiskList[0];
        let summary = `${formatNumber(atRisk.length)} customers at churn risk (${period ?? "last 12 months"}), representing ${formatMoney(totalAtRiskRevenue, currency)} in historical revenue.`;
        summary += ` Most valuable at-risk: ${topAtRisk.name} (${topAtRisk.total_spend}, ${topAtRisk.days_overdue} days overdue).`;
        summary += ` These customers have gone 2x+ longer than their normal purchase interval without ordering.`;

        return toolResult({
          summary,
          data: {
            period: period ?? "last_12m",
            total_customers: analytics.totalCustomers,
            repeat_customers: repeatCustomers.length,
            at_risk_count: atRisk.length,
            at_risk_revenue: formatMoney(totalAtRiskRevenue, currency),
            at_risk: atRiskList,
          },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
