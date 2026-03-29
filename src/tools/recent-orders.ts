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

export function registerRecentOrders(server: McpServer) {
  server.tool(
    "get_recent_orders",
    "Get the most recent orders with key details — customer, amount, status, items.",
    {
      limit: z.number().optional().describe("Number of orders (default: 10, max: 50)"),
      status: z.enum(["any", "open", "closed", "cancelled"]).optional().describe("Order status filter (default: any)"),
      financial_status: z.enum(["any", "paid", "unpaid", "partially_paid", "refunded", "partially_refunded"]).optional().describe("Financial status filter (default: any)"),
    },
    async ({ limit, status, financial_status }) => {
      try {
        const cap = Math.min(limit ?? 10, 50);
        const queryParts: string[] = [];
        if (status && status !== "any") queryParts.push(`status:${status}`);
        if (financial_status && financial_status !== "any") queryParts.push(`financial_status:${financial_status}`);
        const queryFilter = queryParts.length > 0 ? `, query: "${queryParts.join(" AND ")}"` : "";

        const gql = `
          query {
            orders(first: ${cap}, sortKey: CREATED_AT, reverse: true${queryFilter}) {
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
            summary: "No orders found matching the criteria.",
            data: { orders: [] },
          });
        }

        const orderLines = orders.slice(0, 5).map((o) => {
          const amount = formatMoney(Number(o.totalPriceSet.shopMoney.amount), currency);
          const customer = o.customer?.displayName ?? "Guest";
          return `${o.name}: ${amount} — ${customer} (${o.displayFinancialStatus}, ${o.displayFulfillmentStatus})`;
        });

        const summary = `${orders.length} recent orders:\n${orderLines.join("\n")}${orders.length > 5 ? `\n...and ${orders.length - 5} more` : ""}`;

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
          data: { orders: formattedOrders },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
