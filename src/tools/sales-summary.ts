import { z } from "zod";
import { runShopifyQL, getStoreCurrency } from "../shopify-client.js";
import { periodToClause, compareToClause } from "../utils/shopifyql-helpers.js";
import { tableToObjects, formatMoney, formatNumber, formatPct, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerSalesSummary(server: McpServer) {
  server.tool(
    "get_sales_summary",
    "Get revenue, orders, AOV, and period comparison for your Shopify store. Works with natural date ranges like 'last_7d', 'this_month', 'last_quarter'.",
    {
      period: z.string().optional().describe(
        "Date range: today, yesterday, last_7d, last_30d, this_week, last_week, this_month, last_month, this_quarter, last_quarter, this_year, last_year, or YYYY-MM-DD:YYYY-MM-DD"
      ),
      compare_to: z.string().optional().describe(
        "Comparison period: previous_period, previous_year, previous_year_match_day_of_week, none"
      ),
    },
    async ({ period, compare_to }) => {
      try {
        const dateClause = periodToClause(period);
        const cmpClause = compareToClause(compare_to ?? "previous_period");
        const withClauses = cmpClause ? "WITH TOTALS, PERCENT_CHANGE" : "WITH TOTALS";

        const query = `FROM sales SHOW total_sales, net_sales, gross_sales, orders, average_order_value, taxes, discounts, returns ${dateClause} ${cmpClause} ${withClauses}`.trim();

        const [result, currency] = await Promise.all([runShopifyQL(query), getStoreCurrency()]);
        const rows = tableToObjects(result);

        if (rows.length === 0) {
          return toolResult({
            summary: `No sales data found for the requested period. This could mean no orders were placed, or the date range is outside your store's history.`,
            data: { period: period ?? "last_7d", rows: [] },
          });
        }

        // With COMPARE TO + TOTALS, ShopifyQL returns comparison rows.
        // The last row is typically the totals row.
        const current = rows[rows.length - 1] as Record<string, unknown>;
        const totalSales = (current.total_sales as number) ?? 0;
        const netSales = (current.net_sales as number) ?? 0;
        const grossSales = (current.gross_sales as number) ?? 0;
        const orders = (current.orders as number) ?? 0;
        const aov = (current.average_order_value as number) ?? 0;
        const taxes = (current.taxes as number) ?? 0;
        const discounts = (current.discounts as number) ?? 0;
        const returns = (current.returns as number) ?? 0;

        let summary = `${period ?? "Last 7 days"}: ${formatMoney(totalSales, currency)} revenue from ${formatNumber(orders)} orders (AOV ${formatMoney(aov, currency)}). Net revenue after returns/discounts: ${formatMoney(netSales, currency)}.`;

        const data: Record<string, unknown> = {
          period: period ?? "last_7d",
          total_sales: totalSales,
          net_sales: netSales,
          gross_sales: grossSales,
          orders,
          average_order_value: aov,
          taxes,
          discounts,
          returns,
          raw_rows: rows,
        };

        return toolResult({ summary, data });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
