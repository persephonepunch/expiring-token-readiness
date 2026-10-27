// Classify stored Shopify sessions for the expiring offline access token deadline.
//
// Pure functions of plain session records: no I/O, no network, and no token value ever
// leaves this module. A record only needs to say WHETHER a token is present, so callers can
// pass booleans instead of secrets.
//
// The signal comes from Shopify's migration guide: an expiring offline token is issued with
// `refresh_token`, `expires_in` and `refresh_token_expires_in`. Shopify's Session object
// stores those as `refreshToken`, `expires` and `refreshTokenExpires`. There is no token
// prefix that tells the two kinds apart, so the stored fields are the evidence.

export const DEADLINES = Object.freeze({
  delist: "2027-01-01", // delisted from the App Store, no new installs
  warning: "2027-01-15", // merchants see a warning in the Shopify admin
  rejected: "2027-04-01", // Admin API requests with non-expiring tokens return 403
});

export const REFRESH_WARN_DAYS = 14;
const DAY = 864e5;

export const STATUS = Object.freeze({
  ready: "ready",
  readyRefreshSoon: "ready-refresh-soon",
  migrate: "migrate",
  brokenRefreshExpired: "broken-refresh-expired",
  brokenNoRefreshToken: "broken-no-refresh-token",
  online: "online",
  unknown: "unknown",
});

const DESCRIBE = {
  [STATUS.ready]: "Expiring token with a valid refresh token",
  [STATUS.readyRefreshSoon]: `Expiring token; refresh token expires within ${REFRESH_WARN_DAYS} days`,
  [STATUS.migrate]: "Non-expiring offline token: migrate with the token exchange",
  [STATUS.brokenRefreshExpired]: "Refresh token expired: the merchant must reopen the app",
  [STATUS.brokenNoRefreshToken]: "Expiring token stored without its refresh token: the chain is broken",
  [STATUS.online]: "Online session: not affected by the deadline",
  [STATUS.unknown]: "No access token stored: cannot tell",
};

export const describe = (status) => DESCRIBE[status] || status;

/** Dates arrive as ISO strings, Date objects, or numbers (Prisma on SQLite: ms; some stores: seconds). */
export function toTime(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

/** "1", "true", 1, true → true; everything else (including absent) → false. */
export function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  return typeof v === "string" && ["1", "true", "t", "yes"].includes(v.trim().toLowerCase());
}

const present = (v) => v != null && v !== "" && v !== false && v !== 0 && v !== "0" && v !== "false";

/**
 * Normalize one record from any source (Prisma Session row, JSON export, CSV row) into the
 * fields the check needs. Accepts Shopify's camelCase names and common snake_case ones.
 */
export function normalize(rec) {
  const pick = (...keys) => { for (const k of keys) if (rec[k] !== undefined) return rec[k]; return undefined; };
  return {
    shop: String(pick("shop", "shop_domain", "myshopify_domain", "domain") ?? "").trim().toLowerCase(),
    online: toBool(pick("isOnline", "is_online", "online")),
    hasAccessToken: present(pick("accessToken", "access_token", "hasAccessToken", "has_access_token")),
    hasRefreshToken: present(pick("refreshToken", "refresh_token", "hasRefreshToken", "has_refresh_token")),
    expires: toTime(pick("expires", "expires_at", "access_token_expires_at")),
    refreshTokenExpires: toTime(pick("refreshTokenExpires", "refresh_token_expires", "refresh_token_expires_at")),
  };
}

/** Classify one normalized session at time `now` (ms). */
export function classify(s, now) {
  if (s.online) return STATUS.online;
  if (!s.hasAccessToken) return STATUS.unknown;
  if (s.hasRefreshToken) {
    if (s.refreshTokenExpires != null && s.refreshTokenExpires <= now) return STATUS.brokenRefreshExpired;
    if (s.refreshTokenExpires != null && s.refreshTokenExpires - now <= REFRESH_WARN_DAYS * DAY) return STATUS.readyRefreshSoon;
    return STATUS.ready;
  }
  // No refresh token: a non-expiring token has no expiry; an expiring one without its
  // refresh token can never be renewed.
  return s.expires == null ? STATUS.migrate : STATUS.brokenNoRefreshToken;
}

const NEEDS_ACTION = new Set([STATUS.migrate, STATUS.brokenRefreshExpired, STATUS.brokenNoRefreshToken]);
export const needsAction = (status) => NEEDS_ACTION.has(status);

const daysUntil = (iso, now) => Math.ceil((Date.parse(`${iso}T00:00:00Z`) - now) / DAY);

/**
 * Check a list of raw records. One shop can have several sessions (an offline one plus
 * online ones); the shop's verdict is its offline session's, so online rows don't hide a
 * shop that still needs migrating.
 */
export function check(records, now = Date.now()) {
  const sessions = records.map((r) => {
    const s = normalize(r);
    return { shop: s.shop, status: classify(s, now), expires: s.expires, refreshTokenExpires: s.refreshTokenExpires };
  });
  const counts = Object.fromEntries(Object.values(STATUS).map((k) => [k, 0]));
  for (const s of sessions) counts[s.status]++;

  const byShop = new Map();
  for (const s of sessions) {
    if (!s.shop) continue;
    const prev = byShop.get(s.shop);
    // Prefer the offline verdict; among offline ones, the worst.
    const rank = (st) => (st === STATUS.online ? 0 : st === STATUS.unknown ? 1 : needsAction(st) ? 3 : 2);
    if (!prev || rank(s.status) > rank(prev.status)) byShop.set(s.shop, s);
  }
  const shops = [...byShop.values()].sort((a, b) => Number(needsAction(b.status)) - Number(needsAction(a.status)) || a.shop.localeCompare(b.shop));
  const action = shops.filter((s) => needsAction(s.status));

  return {
    checkedAt: new Date(now).toISOString(),
    deadlines: Object.fromEntries(Object.entries(DEADLINES).map(([k, d]) => [k, { date: d, daysLeft: daysUntil(d, now) }])),
    totals: { sessions: sessions.length, shops: shops.length, shopsNeedingAction: action.length },
    counts,
    shops,
    ready: action.length === 0 && shops.some((s) => s.status !== STATUS.online && s.status !== STATUS.unknown),
  };
}
