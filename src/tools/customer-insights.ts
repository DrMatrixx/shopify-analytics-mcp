import { z } from "zod";
import { runShopifyQL } from "../shopify-client.js";
import { periodToClause } from "../utils/shopifyql-helpers.js";
import { tableToObjects, formatMoney, formatNumber, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCustomerInsights(server: McpServer) {
  server.tool(
    "get_customer_insights",
    "Get customer analytics: total customers, top spenders, and aggregate metrics.",
    {
      period: z.string().optional().describe("Date range (default: last_30d)"),
    },
    async ({ period }) => {
      try {
        const dateClause = periodToClause(period ?? "last_30d");

        // Aggregate customer metrics from sales
        const aggregateQuery = `FROM sales SHOW orders, total_sales, customers ${dateClause} WITH TOTALS`;
        const aggregateResult = await runShopifyQL(aggregateQuery);
        const aggregateRows = tableToObjects(aggregateResult);

        const totals = aggregateRows.length > 0 ? aggregateRows[aggregateRows.length - 1] : null;
        const totalOrders = (totals?.orders as number) ?? 0;
        const totalSales = (totals?.total_sales as number) ?? 0;
        const totalCustomers = (totals?.customers as number) ?? 0;

        // Top spenders
        const topSpendersQuery = `FROM customers SHOW customer_name, customer_email, total_orders, total_amount_spent ORDER BY total_amount_spent DESC LIMIT 10`;

        let topSpenders: Record<string, unknown>[] = [];
        try {
          const spendersResult = await runShopifyQL(topSpendersQuery);
          topSpenders = tableToObjects(spendersResult);
        } catch {
          // customers dataset may not be available on all plans
        }

        const avgOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;

        let summary = `Customer insights (${period ?? "last 30 days"}): ${formatNumber(totalCustomers)} customers, ${formatNumber(totalOrders)} orders, ${formatMoney(totalSales)} total revenue (AOV ${formatMoney(avgOrderValue)}).`;

        if (topSpenders.length > 0) {
          const top = topSpenders[0];
          summary += ` Top spender: ${top.customer_name} (${formatMoney(top.total_amount_spent as number)}).`;
        }

        return toolResult({
          summary,
          data: {
            period: period ?? "last_30d",
            total_customers: totalCustomers,
            total_orders: totalOrders,
            total_sales: totalSales,
            average_order_value: avgOrderValue,
            top_spenders: topSpenders,
          },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
