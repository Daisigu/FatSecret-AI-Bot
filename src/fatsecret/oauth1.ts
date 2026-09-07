import crypto from "node:crypto";
import OAuth from "oauth-1.0a";

export interface Token {
  key: string;
  secret: string;
}

/**
 * FatSecret only supports OAuth 1.0a (HMAC-SHA1) for anything that touches a
 * user's profile (food diary, exercise diary, weight). Public read-only
 * methods also accept OAuth 2.0 client-credentials, but since this bot only
 * ever acts as a single user, we standardize on OAuth 1.0a everywhere so
 * there's only one auth code path.
 */
export function createOAuth1(consumerKey: string, consumerSecret: string) {
  return new OAuth({
    consumer: { key: consumerKey, secret: consumerSecret },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });
}

/** oauth-1.0a types oauth_timestamp as a number; URLSearchParams needs strings. */
function stringifyValues(obj: OAuth.Authorization): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj as unknown as Record<string, string | number>).map(([k, v]) => [k, String(v)])
  );
}

/**
 * Signs a GET request (used for the 3-legged bootstrap "access_token" step)
 * and returns the full URL with query string.
 */
export function buildSignedGetUrl(
  oauth: OAuth,
  baseUrl: string,
  params: Record<string, string>,
  token?: Token
): string {
  const requestData = { url: baseUrl, method: "GET", data: params };
  const authorized = stringifyValues(oauth.authorize(requestData, token));
  const query = new URLSearchParams({ ...params, ...authorized }).toString();
  return `${baseUrl}?${query}`;
}

/**
 * Signs a POST request (used for the 3-legged bootstrap "request_token" step
 * and for every call to the REST API) and returns the form-urlencoded body.
 */
export function buildSignedPostBody(
  oauth: OAuth,
  baseUrl: string,
  params: Record<string, string>,
  token?: Token
): string {
  const requestData = { url: baseUrl, method: "POST", data: params };
  const authorized = stringifyValues(oauth.authorize(requestData, token));
  return new URLSearchParams({ ...params, ...authorized }).toString();
}

/** Kept as a thin alias for the REST API call site (platform.fatsecret.com). */
export function buildSignedApiBody(
  oauth: OAuth,
  params: Record<string, string>,
  token: Token
): string {
  return buildSignedPostBody(oauth, "https://platform.fatsecret.com/rest/server.api", params, token);
}

