import { z } from "zod";
import { getCustomerAnalytics } from "../utils/customer-data.js";
import { formatMoney, formatNumber, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCustomerHealthReport(server: McpServer) {
  server.tool(
    "get_customer_health_report",
    "Get a full customer health diagnosis for your store. Analyzes RFM segments, churn risk, and lifetime value in one report with severity-ranked findings and recommended actions.",
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
            summary: `No customers found for the requested period (${period ?? "last 12 months"}). Your store may be very new or have no orders in this timeframe.`,
            data: { period: period ?? "last_12m", findings: [] },
          });
        }

        const { customers, segmentCounts, currency } = analytics;

        // Small store: simplified report
        if (analytics.totalCustomers < 10) {
          const repeatCount = customers.filter(
            (c) => c.orderCount >= 2
          ).length;
          const avgSpend =
            analytics.totalRevenue / analytics.totalCustomers;

          return toolResult({
            summary: `Your store is early-stage with ${formatNumber(analytics.totalCustomers)} customers (${period ?? "last 12 months"}). ${repeatCount} have ordered more than once. Average spend: ${formatMoney(avgSpend, currency)}. Focus on growing your customer base and getting repeat purchases before diving into segmentation.`,
            data: {
              period: period ?? "last_12m",
              total_customers: analytics.totalCustomers,
              repeat_customers: repeatCount,
              total_revenue: formatMoney(analytics.totalRevenue, currency),
              avg_spend: formatMoney(avgSpend, currency),
              note: "Store has fewer than 10 customers — full segmentation analysis requires more data",
            },
          });
        }

        // Full analysis
        const findings: Array<{
          severity: "high" | "medium" | "low";
          finding: string;
          action: string;
        }> = [];

        // 1. Segment composition
        let segmentAnalysis: Record<string, { count: number; percentage: string }> | null = null;
        try {
          segmentAnalysis = {};
          for (const [segment, count] of Object.entries(segmentCounts)) {
            segmentAnalysis[segment] = {
              count,
              percentage: `${((count / analytics.totalCustomers) * 100).toFixed(1)}%`,
            };
          }
        } catch {
          // Segment analysis failed — continue with partial report
        }

        // 2. Revenue concentration
        let revenueConcentration: {
          top_10_pct_revenue_share: string;
          top_10_pct_count: number;
        } | null = null;
        try {
          const sortedBySpend = [...customers].sort(
            (a, b) => b.totalSpend - a.totalSpend
          );
          const top10PctCount = Math.max(
            1,
            Math.ceil(customers.length * 0.1)
          );
          const top10PctRevenue = sortedBySpend
            .slice(0, top10PctCount)
            .reduce((sum, c) => sum + c.totalSpend, 0);
          const concentrationPct =
            (top10PctRevenue / analytics.totalRevenue) * 100;

          revenueConcentration = {
            top_10_pct_revenue_share: `${concentrationPct.toFixed(1)}%`,
            top_10_pct_count: top10PctCount,
          };

          if (concentrationPct > 50) {
            findings.push({
              severity: "medium",
              finding: `Your top ${top10PctCount} customers (10%) drive ${concentrationPct.toFixed(0)}% of revenue. High concentration means losing a few key customers would significantly impact your business.`,
              action: `Identify your top ${top10PctCount} customers by name and ensure they have an exceptional experience. Consider a VIP program or personal outreach.`,
            });
          }
        } catch {
          // Revenue concentration failed — continue
        }

        // 3. Churn risk severity
        let churnAnalysis: {
          at_risk_count: number;
          at_risk_revenue: string;
          top_at_risk: Array<{
            name: string;
            spend: string;
            days_overdue: number;
          }>;
        } | null = null;
        try {
          const repeatCustomers = customers.filter(
            (c) => c.orderCount >= 2 && c.churnRatio !== null
          );
          const atRisk = repeatCustomers
            .filter((c) => c.churnRatio! > 2.0)
            .sort((a, b) => b.totalSpend - a.totalSpend);
          const atRiskRevenue = atRisk.reduce(
            (sum, c) => sum + c.totalSpend,
            0
          );

          churnAnalysis = {
            at_risk_count: atRisk.length,
            at_risk_revenue: formatMoney(atRiskRevenue, currency),
            top_at_risk: atRisk.slice(0, 5).map((c) => {
              const expectedReorder = new Date(
                c.lastOrderDate.getTime() +
                  (c.avgIntervalDays ?? 0) * 24 * 60 * 60 * 1000
              );
              return {
                name: c.name,
                spend: formatMoney(c.totalSpend, currency),
                days_overdue: Math.floor(
                  (Date.now() - expectedReorder.getTime()) /
                    (1000 * 60 * 60 * 24)
                ),
              };
            }),
          };

          if (atRisk.length > 0) {
            findings.push({
              severity: "high",
              finding: `${atRisk.length} valuable customers are at churn risk, representing ${formatMoney(atRiskRevenue, currency)} in historical spend. They've gone 2x+ longer than their normal purchase interval.`,
              action: `Reach out to your top at-risk customers immediately. A personalized email or discount code could bring them back before they're gone for good.`,
            });
          }
        } catch {
          // Churn analysis failed — continue
        }

        // 4. Repeat purchase rate
        let repeatAnalysis: {
          repeat_rate: string;
          one_time_count: number;
          repeat_count: number;
        } | null = null;
        try {
          const repeatCount = customers.filter(
            (c) => c.orderCount >= 2
          ).length;
          const oneTimeCount = analytics.totalCustomers - repeatCount;
          const repeatRate =
            (repeatCount / analytics.totalCustomers) * 100;

          repeatAnalysis = {
            repeat_rate: `${repeatRate.toFixed(1)}%`,
            one_time_count: oneTimeCount,
            repeat_count: repeatCount,
          };

          if (repeatRate < 20) {
            findings.push({
              severity: "high",
              finding: `Only ${repeatRate.toFixed(0)}% of customers have ordered more than once. ${oneTimeCount} customers bought once and never came back.`,
              action: `Set up a post-purchase email sequence. Send a follow-up 14 days after first purchase with a related product recommendation or a small discount on their next order.`,
            });
          } else if (repeatRate < 40) {
            findings.push({
              severity: "medium",
              finding: `${repeatRate.toFixed(0)}% repeat purchase rate. Room for improvement — the best e-commerce stores see 40-60%.`,
              action: `Consider a loyalty program or subscription option for your most-reordered products.`,
            });
          }
        } catch {
          // Repeat analysis failed — continue
        }

        // 5. Check for Champions
        const champCount = segmentCounts["Champions"] ?? 0;
        if (champCount > 0 && analytics.totalCustomers >= 20) {
          const champPct =
            (champCount / analytics.totalCustomers) * 100;
          if (champPct > 15) {
            findings.push({
              severity: "low",
              finding: `${champCount} Champions (${champPct.toFixed(0)}% of customers) — your most engaged, high-spending customers. This is a strong base.`,
              action: `Keep your Champions engaged. They're your best source of referrals and reviews. Ask them for testimonials.`,
            });
          }
        }

        // Sort findings by severity
        const severityOrder = { high: 0, medium: 1, low: 2 };
        findings.sort(
          (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
        );

        // Build summary
        const highCount = findings.filter(
          (f) => f.severity === "high"
        ).length;
        const medCount = findings.filter(
          (f) => f.severity === "medium"
        ).length;

        let summary = `Customer health report (${period ?? "last 12 months"}): ${formatNumber(analytics.totalCustomers)} customers, ${formatMoney(analytics.totalRevenue, currency)} total revenue.`;

        if (highCount > 0) {
          summary += ` ${highCount} high-severity finding${highCount > 1 ? "s" : ""} need attention.`;
        }
        if (medCount > 0) {
          summary += ` ${medCount} medium-severity finding${medCount > 1 ? "s" : ""}.`;
        }
        if (findings.length === 0) {
          summary += ` No major issues found — your customer base looks healthy.`;
        }

        const data: Record<string, unknown> = {
          period: period ?? "last_12m",
          total_customers: analytics.totalCustomers,
          total_revenue: formatMoney(analytics.totalRevenue, currency),
          findings,
        };

        if (segmentAnalysis) data.segments = segmentAnalysis;
        if (revenueConcentration)
          data.revenue_concentration = revenueConcentration;
        if (churnAnalysis) data.churn_risk = churnAnalysis;
        if (repeatAnalysis) data.repeat_purchase = repeatAnalysis;

        // Note any sections that failed
        const availableSections = [];
        if (segmentAnalysis) availableSections.push("segments");
        if (revenueConcentration) availableSections.push("revenue_concentration");
        if (churnAnalysis) availableSections.push("churn_risk");
        if (repeatAnalysis) availableSections.push("repeat_purchase");
        data.sections_available = availableSections;

        return toolResult({ summary, data });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
