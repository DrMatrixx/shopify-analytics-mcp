# TODOs

## Add tests for existing 14 tools
**Why:** Zero test coverage on original tools. Any changes to shared utilities (formatters, shopifyql-helpers) could break them silently.
**Context:** Vitest is now set up. Follow the same mock pattern used in `test/tools/customer-tools.test.ts`. Mock `runShopifyQL` and `graphql`, provide fixture data for each tool's ShopifyQL response format.
**Depends on:** vitest setup (done in v1.1.0)

## Add cohort analysis tool
**Why:** Natural follow-up to the customer intelligence suite. Answers "are the customers I acquired in January sticking around?" which is the next question after RFM/churn.
**Context:** Would add `get_customer_cohort_analysis` tool. Groups customers by first-purchase month, tracks retention over time. Can reuse `customer-data.ts` for data fetching. ShopifyQL may have a built-in cohort report, but unclear if it's accessible via API. May need to compute client-side from order data (2D matrix of cohorts x months).
**Depends on:** customer-data.ts from v1.1.0
