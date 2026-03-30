#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerSalesSummary } from "./tools/sales-summary.js";
import { registerTopProducts } from "./tools/top-products.js";
import { registerOrderTrends } from "./tools/order-trends.js";
import { registerRecentOrders } from "./tools/recent-orders.js";
import { registerOrderDetails } from "./tools/order-details.js";
import { registerCustomerInsights } from "./tools/customer-insights.js";
import { registerInventoryStatus } from "./tools/inventory-status.js";
import { registerProductPerformance } from "./tools/product-performance.js";
import { registerSalesByGeography } from "./tools/sales-by-geography.js";
import { registerSalesByChannel } from "./tools/sales-by-channel.js";
import { registerDiscountPerformance } from "./tools/discount-performance.js";
import { registerRefundsSummary } from "./tools/refunds-summary.js";
import { registerSearchOrders } from "./tools/search-orders.js";
import { registerRunShopifyQL } from "./tools/run-shopifyql.js";
import { registerCustomerRfmSegments } from "./tools/customer-rfm-segments.js";
import { registerCustomerChurnRisk } from "./tools/customer-churn-risk.js";
import { registerCustomerLtvSummary } from "./tools/customer-ltv-summary.js";
import { registerCustomerHealthReport } from "./tools/customer-health-report.js";

const server = new McpServer({
  name: "shopify-analytics",
  version: "1.0.0",
});

// Register all 18 tools
registerSalesSummary(server);
registerTopProducts(server);
registerOrderTrends(server);
registerRecentOrders(server);
registerOrderDetails(server);
registerCustomerInsights(server);
registerInventoryStatus(server);
registerProductPerformance(server);
registerSalesByGeography(server);
registerSalesByChannel(server);
registerDiscountPerformance(server);
registerRefundsSummary(server);
registerSearchOrders(server);
registerRunShopifyQL(server);
registerCustomerRfmSegments(server);
registerCustomerChurnRisk(server);
registerCustomerLtvSummary(server);
registerCustomerHealthReport(server);

// Start the server with stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("Shopify Analytics MCP server running on stdio");
