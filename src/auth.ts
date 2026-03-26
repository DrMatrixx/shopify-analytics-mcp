import { URLSearchParams } from "node:url";

const SHOP = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export type AuthMethod = "client_credentials" | "legacy";

export function getAuthMethod(): AuthMethod {
  if (CLIENT_ID && CLIENT_SECRET) return "client_credentials";
  if (ACCESS_TOKEN) return "legacy";
  throw new Error(
    "Missing Shopify credentials. Provide either:\n" +
      "  1. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (recommended, Dev Dashboard app)\n" +
      "  2. SHOPIFY_ACCESS_TOKEN (legacy custom app token)\n" +
      "Also required: SHOPIFY_STORE (your myshopify.com subdomain, e.g. 'my-store')"
  );
}

export function getStoreDomain(): string {
  if (!SHOP) {
    throw new Error(
      "Missing SHOPIFY_STORE environment variable. Set it to your myshopify.com subdomain (e.g. 'my-store')."
    );
  }
  return SHOP;
}

export async function getAccessToken(): Promise<string> {
  const method = getAuthMethod();

  if (method === "legacy") {
    return ACCESS_TOKEN!;
  }

  // Client credentials grant with auto-refresh
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const store = getStoreDomain();
  const response = await fetch(
    `https://${store}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID!,
        client_secret: CLIENT_SECRET!,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 403 || text.includes("shop_not_permitted")) {
      throw new Error(
        "Client credentials auth requires the app and store to be in the same organization. " +
          "Make sure you created the app in the Dev Dashboard while logged into the same org that owns the store."
      );
    }
    throw new Error(
      `Authentication failed (${response.status}). Check your Client ID and Client Secret in the MCP config. ` +
        `Verify your credentials in the Shopify Dev Dashboard under Settings.`
    );
  }

  const { access_token, expires_in } = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  return cachedToken;
}
