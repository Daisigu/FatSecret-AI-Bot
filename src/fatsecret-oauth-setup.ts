/**
 * Run once with `npm run fatsecret:auth`.
 *
 * FatSecret's diary-writing endpoints (food_entry.create) require a
 * 3-legged OAuth 1.0a user access token - there's no way around logging in
 * once through fatsecret.com. This script walks you through it and prints
 * the FATSECRET_ACCESS_TOKEN / FATSECRET_ACCESS_TOKEN_SECRET to put in .env.
 *
 * NOTE: the 3-legged bootstrap endpoints live on authentication.fatsecret.com
 * (not www.fatsecret.com - that older host is currently behind a Cloudflare
 * managed challenge that blocks non-browser clients, per FatSecret's own
 * developer forum). Step 1 (request_token) is a POST, steps 2/3 are GET.
 *
 * The resulting token does not expire (FatSecret access tokens are
 * long-lived) unless you revoke it from your FatSecret account settings.
 */
import readline from "node:readline/promises";
import { createOAuth1, buildSignedGetUrl, buildSignedPostBody } from "./fatsecret/oauth1.js";
import { fetchText, HttpError } from "./utils/http.js";

const AUTH_HOST = "https://authentication.fatsecret.com";

const consumerKey = process.env.FATSECRET_CONSUMER_KEY;
const consumerSecret = process.env.FATSECRET_CONSUMER_SECRET;

if (!consumerKey || !consumerSecret) {
  console.error(
    "Set FATSECRET_CONSUMER_KEY and FATSECRET_CONSUMER_SECRET in .env first."
  );
  process.exit(1);
}

const oauth = createOAuth1(consumerKey, consumerSecret);

function parseFormBody(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

async function main() {
  // Step 1: request token (POST, unsigned by a token since we don't have one yet).
  // oauth_callback=oob switches FatSecret into PIN-based ("out of band") mode
  // instead of redirecting to a callback URL.
  const requestTokenBody = buildSignedPostBody(
    oauth,
    `${AUTH_HOST}/oauth/request_token`,
    { oauth_callback: "oob" }
  );
  const requestTokenRaw = await fetchText(`${AUTH_HOST}/oauth/request_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: requestTokenBody,
  });
  const requestToken = parseFormBody(requestTokenRaw);

  if (requestToken.oauth_callback_confirmed !== "true") {
    console.error("Unexpected response from request_token:", requestTokenRaw);
    process.exit(1);
  }

  // Step 2: send the user to authorize the app and get a PIN back.
  // This step is a plain (unsigned) GET redirect - only oauth_token is needed.
  const authorizeUrl = `${AUTH_HOST}/oauth/authorize?oauth_token=${encodeURIComponent(
    requestToken.oauth_token
  )}`;
  console.log("\n1. Open this URL in a browser, log in, and approve access:\n");
  console.log(`   ${authorizeUrl}\n`);
  console.log("2. FatSecret will show you a PIN code.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pin = (await rl.question("Paste the PIN here: ")).trim();
  rl.close();

  // Step 3: exchange the request token + PIN for a permanent access token (GET).
  // Per FatSecret's docs, this must be signed with consumer_secret + the
  // *request token's* secret (not the eventual access token secret).
  const accessTokenUrl = buildSignedGetUrl(
    oauth,
    `${AUTH_HOST}/oauth/access_token`,
    { oauth_verifier: pin },
    { key: requestToken.oauth_token, secret: requestToken.oauth_token_secret }
  );
  const accessTokenRaw = await fetchText(accessTokenUrl);
  const accessToken = parseFormBody(accessTokenRaw);

  if (!accessToken.oauth_token || !accessToken.oauth_token_secret) {
    console.error("Unexpected response from access_token:", accessTokenRaw);
    process.exit(1);
  }

  console.log("\nSuccess! Add these lines to your .env:\n");
  console.log(`FATSECRET_ACCESS_TOKEN=${accessToken.oauth_token}`);
  console.log(`FATSECRET_ACCESS_TOKEN_SECRET=${accessToken.oauth_token_secret}\n`);
}

main().catch((err) => {
  if (err instanceof HttpError) {
    console.error("OAuth setup failed:", err.body || err.message);
  } else {
    console.error("OAuth setup failed:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
