import { z } from "zod";
import { graphql, getStoreCurrency } from "../shopify-client.js";
import { formatMoney, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface OrdersResponse {
  orders: {
    nodes: Array<{
      id: string;
      name: string;
      createdAt: string;
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      displayFinancialStatus: string;
      displayFulfillmentStatus: string;
      customer: { displayName: string; email: string } | null;
      lineItems: { nodes: Array<{ title: string; quantity: number }> };
    }>;
  };
}

const SORT_KEY_MAP: Record<string, string> = {
  created_at: "CREATED_AT",
  total_price: "TOTAL_PRICE",
  order_number: "ORDER_NUMBER",
};

export function registerSearchOrders(server: McpServer) {
  server.tool(
    "search_orders",
    "Search orders using Shopify query syntax. Examples: 'financial_status:refunded', 'email:jane@example.com', 'tag:rush', 'created_at:>2026-03-01'.",
    {
      query: z.string().describe("Shopify query string (e.g. 'financial_status:refunded', 'email:jane@example.com')"),
      limit: z.number().optional().describe("Max results (default: 20, max: 50)"),
      sort_by: z.enum(["created_at", "total_price", "order_number"]).optional().describe("Sort field (default: created_at)"),
    },
    async ({ query, limit, sort_by }) => {
      try {
        const cap = Math.min(limit ?? 20, 50);
        const sortKey = SORT_KEY_MAP[sort_by ?? "created_at"];

        const gql = `
          query {
            orders(first: ${cap}, sortKey: ${sortKey}, reverse: true, query: "${query.replace(/"/g, '\\"')}") {
              nodes {
                id
                name
                createdAt
                totalPriceSet { shopMoney { amount currencyCode } }
                displayFinancialStatus
                displayFulfillmentStatus
                customer { displayName email }
                lineItems(first: 5) {
                  nodes { title quantity }
                }
              }
            }
          }
        `;

        const [data, currency] = await Promise.all([graphql<OrdersResponse>(gql), getStoreCurrency()]);
        const orders = data.orders.nodes;

        if (orders.length === 0) {
          return toolResult({
            summary: `No orders found matching "${query}".`,
            data: { orders: [] },
          });
        }

        const orderLines = orders.slice(0, 5).map((o) => {
          const amount = formatMoney(Number(o.totalPriceSet.shopMoney.amount), currency);
          const customer = o.customer?.displayName ?? "Guest";
          return `${o.name}: ${amount} — ${customer} (${o.displayFinancialStatus})`;
        });

        const summary = `Found ${orders.length} orders matching "${query}":\n${orderLines.join("\n")}${orders.length > 5 ? `\n...and ${orders.length - 5} more` : ""}`;

        const formattedOrders = orders.map((o) => ({
          id: o.id,
          name: o.name,
          created_at: o.createdAt,
          total: Number(o.totalPriceSet.shopMoney.amount),
          currency: o.totalPriceSet.shopMoney.currencyCode,
          financial_status: o.displayFinancialStatus,
          fulfillment_status: o.displayFulfillmentStatus,
          customer: o.customer ? { name: o.customer.displayName, email: o.customer.email } : null,
          items: o.lineItems.nodes.map((li) => ({ title: li.title, quantity: li.quantity })),
        }));

        return toolResult({
          summary,
          data: { query, orders: formattedOrders },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
