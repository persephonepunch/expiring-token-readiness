// Read session records from where Shopify apps keep them. Each reader returns
// { records, notes }; records carry presence flags, not token values, wherever the source
// allows it (SQLite: the query never selects a token).

import { readFileSync } from "node:fs";

const quoteIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`table name "${name}" is not a plain identifier`);
  return `"${name}"`;
};

/**
 * Prisma's SQLite file from the Shopify app template (prisma/dev.sqlite by default).
 * Selects only whether each token is present, never the token itself.
 */
export async function readSqlite(file, table = "Session") {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { throw new Error("reading SQLite needs Node 22.5 or later (node:sqlite)"); }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const cols = new Set(db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c) => c.name));
    if (!cols.size) throw new Error(`no table "${table}" in ${file}`);
    const notes = [];
    const has = (c) => cols.has(c);
    if (!has("refreshToken") || !has("refreshTokenExpires")) {
      notes.push(`The ${table} table has no refreshToken / refreshTokenExpires columns: add them to the Prisma schema before migrating, or refresh tokens can't be stored.`);
    }
    const sel = [
      "shop",
      has("isOnline") ? "isOnline" : "0 AS isOnline",
      has("expires") ? "expires" : "NULL AS expires",
      has("accessToken") ? "(accessToken IS NOT NULL AND accessToken <> '') AS hasAccessToken" : "0 AS hasAccessToken",
      has("refreshToken") ? "(refreshToken IS NOT NULL AND refreshToken <> '') AS hasRefreshToken" : "0 AS hasRefreshToken",
      has("refreshTokenExpires") ? "refreshTokenExpires" : "NULL AS refreshTokenExpires",
    ].join(", ");
    const records = db.prepare(`SELECT ${sel} FROM ${quoteIdent(table)}`).all().map((r) => ({ ...r }));
    return { records, notes };
  } finally {
    db.close();
  }
}

/** A JSON array of session-like objects, or { sessions: [...] }. */
export function readJson(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const records = Array.isArray(data) ? data : Array.isArray(data?.sessions) ? data.sessions : null;
  if (!records) throw new Error(`${file}: expected a JSON array of sessions, or { "sessions": [...] }`);
  return { records, notes: [] };
}

/** RFC 4180 CSV with a header row (quoted fields, doubled quotes, CRLF or LF). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  if (!rows.length) return [];
  const [head, ...body] = rows;
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}

export function readCsv(file) {
  return { records: parseCsv(readFileSync(file, "utf8")), notes: [] };
}
