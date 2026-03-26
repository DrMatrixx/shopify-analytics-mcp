import { z } from "zod";
import { graphql } from "../shopify-client.js";
import { formatMoney, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface OrderSearchResponse {
  orders: {
    nodes: Array<{
      id: string;
      name: string;
      createdAt: string;
      closedAt: string | null;
      cancelledAt: string | null;
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      subtotalPriceSet: { shopMoney: { amount: string } };
      totalTaxSet: { shopMoney: { amount: string } };
      totalShippingPriceSet: { shopMoney: { amount: string } };
      totalDiscountsSet: { shopMoney: { amount: string } };
      totalRefundedSet: { shopMoney: { amount: string } };
      displayFinancialStatus: string;
      displayFulfillmentStatus: string;
      note: string | null;
      tags: string[];
      customer: { displayName: string; email: string; ordersCount: string } | null;
      shippingAddress: { formatted: string[] } | null;
      billingAddress: { formatted: string[] } | null;
      lineItems: {
        nodes: Array<{
          title: string;
          quantity: number;
          variant: { title: string; sku: string | null } | null;
          originalTotalSet: { shopMoney: { amount: string } };
          discountedTotalSet: { shopMoney: { amount: string } };
        }>;
      };
      fulfillments: Array<{
        status: string;
        createdAt: string;
        trackingInfo: Array<{ number: string; url: string | null }>;
      }>;
      refunds: Array<{
        createdAt: string;
        totalRefundedSet: { shopMoney: { amount: string } };
        note: string | null;
      }>;
      transactions: Array<{
        kind: string;
        status: string;
        amountSet: { shopMoney: { amount: string } };
        gateway: string;
        processedAt: string;
      }>;
    }>;
  };
}

export function registerOrderDetails(server: McpServer) {
  server.tool(
    "get_order_details",
    "Get full details for a specific order — line items, shipping, billing, transactions, fulfillments, refunds.",
    {
      order_number: z.string().describe("Order number (e.g. '1042') or full Shopify GID"),
    },
    async ({ order_number }) => {
      try {
        // If it looks like a GID, search differently
        const queryFilter = order_number.startsWith("gid://")
          ? `id:${order_number}`
          : `name:#${order_number}`;

        const gql = `
          query {
            orders(first: 1, query: "${queryFilter}") {
              nodes {
                id
                name
                createdAt
                closedAt
                cancelledAt
                totalPriceSet { shopMoney { amount currencyCode } }
                subtotalPriceSet { shopMoney { amount } }
                totalTaxSet { shopMoney { amount } }
                totalShippingPriceSet { shopMoney { amount } }
                totalDiscountsSet { shopMoney { amount } }
                totalRefundedSet { shopMoney { amount } }
                displayFinancialStatus
                displayFulfillmentStatus
                note
                tags
                customer { displayName email ordersCount }
                shippingAddress { formatted }
                billingAddress { formatted }
                lineItems(first: 50) {
                  nodes {
                    title
                    quantity
                    variant { title sku }
                    originalTotalSet { shopMoney { amount } }
                    discountedTotalSet { shopMoney { amount } }
                  }
                }
                fulfillments {
                  status
                  createdAt
                  trackingInfo { number url }
                }
                refunds {
                  createdAt
                  totalRefundedSet { shopMoney { amount } }
                  note
                }
                transactions(first: 10) {
                  kind
                  status
                  amountSet { shopMoney { amount } }
                  gateway
                  processedAt
                }
              }
            }
          }
        `;

        const data = await graphql<OrderSearchResponse>(gql);
        const orders = data.orders.nodes;

        if (orders.length === 0) {
          return toolResult({
            summary: `No order found matching "${order_number}". Check the order number and try again.`,
            data: {},
          });
        }

        const o = orders[0];
        const total = Number(o.totalPriceSet.shopMoney.amount);
        const itemCount = o.lineItems.nodes.reduce((sum, li) => sum + li.quantity, 0);

        const summary = `Order ${o.name}: ${formatMoney(total)} (${o.displayFinancialStatus}, ${o.displayFulfillmentStatus}). ${itemCount} items. Customer: ${o.customer?.displayName ?? "Guest"}. Created: ${o.createdAt.split("T")[0]}.`;

        const detail = {
          id: o.id,
          name: o.name,
          created_at: o.createdAt,
          closed_at: o.closedAt,
          cancelled_at: o.cancelledAt,
          total: total,
          subtotal: Number(o.subtotalPriceSet.shopMoney.amount),
          tax: Number(o.totalTaxSet.shopMoney.amount),
          shipping: Number(o.totalShippingPriceSet.shopMoney.amount),
          discounts: Number(o.totalDiscountsSet.shopMoney.amount),
          refunded: Number(o.totalRefundedSet.shopMoney.amount),
          currency: o.totalPriceSet.shopMoney.currencyCode,
          financial_status: o.displayFinancialStatus,
          fulfillment_status: o.displayFulfillmentStatus,
          note: o.note,
          tags: o.tags,
          customer: o.customer
            ? { name: o.customer.displayName, email: o.customer.email, total_orders: o.customer.ordersCount }
            : null,
          shipping_address: o.shippingAddress?.formatted.join(", ") ?? null,
          billing_address: o.billingAddress?.formatted.join(", ") ?? null,
          line_items: o.lineItems.nodes.map((li) => ({
            title: li.title,
            quantity: li.quantity,
            variant: li.variant?.title ?? null,
            sku: li.variant?.sku ?? null,
            original_total: Number(li.originalTotalSet.shopMoney.amount),
            discounted_total: Number(li.discountedTotalSet.shopMoney.amount),
          })),
          fulfillments: o.fulfillments.map((f) => ({
            status: f.status,
            created_at: f.createdAt,
            tracking: f.trackingInfo,
          })),
          refunds: o.refunds.map((r) => ({
            created_at: r.createdAt,
            amount: Number(r.totalRefundedSet.shopMoney.amount),
            note: r.note,
          })),
          transactions: o.transactions.map((t) => ({
            kind: t.kind,
            status: t.status,
            amount: Number(t.amountSet.shopMoney.amount),
            gateway: t.gateway,
            processed_at: t.processedAt,
          })),
        };

        return toolResult({ summary, data: detail });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
