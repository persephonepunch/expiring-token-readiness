// Render a check result for people (text, Markdown) or machines (JSON). Shop domains can be
// replaced by a short hash with redact, so a report can be shared without naming merchants.

import { createHash } from "node:crypto";
import { STATUS, describe, needsAction } from "./classify.js";

const day = (t) => (t == null ? "" : new Date(t).toISOString().slice(0, 10));
const label = (shop, redact) => (redact ? `shop-${createHash("sha256").update(shop).digest("hex").slice(0, 10)}` : shop);
const ORDER = [STATUS.migrate, STATUS.brokenNoRefreshToken, STATUS.brokenRefreshExpired, STATUS.readyRefreshSoon, STATUS.ready, STATUS.online, STATUS.unknown];

export function toJson(result, { redact = false, project = [], notes = [] } = {}) {
  return JSON.stringify({
    ...result,
    shops: result.shops.map((s) => ({ shop: label(s.shop, redact), status: s.status, expires: day(s.expires) || null, refreshTokenExpires: day(s.refreshTokenExpires) || null })),
    project,
    notes,
  }, null, 2);
}

export function toText(result, { redact = false, project = [], notes = [], limit = 50 } = {}) {
  const d = result.deadlines;
  const out = [];
  out.push(`Expiring offline token readiness  (checked ${result.checkedAt.slice(0, 10)})`);
  out.push(`Deadlines: ${d.delist.date} delisting (${d.delist.daysLeft} days) · ${d.rejected.date} Admin API 403 (${d.rejected.daysLeft} days)`);
  out.push("");
  out.push(result.totals.shopsNeedingAction
    ? `ACTION NEEDED: ${result.totals.shopsNeedingAction} of ${result.totals.shops} shops`
    : result.ready ? `READY: all ${result.totals.shops} shops have expiring tokens` : "NOTHING TO JUDGE: no offline sessions with an access token");
  out.push("");
  for (const st of ORDER) if (result.counts[st]) out.push(`  ${String(result.counts[st]).padStart(6)}  ${describe(st)}`);
  const shown = result.shops.filter((s) => needsAction(s.status) || s.status === STATUS.readyRefreshSoon).slice(0, limit);
  if (shown.length) {
    out.push("", "Shops to act on:");
    for (const s of shown) out.push(`  ${label(s.shop, redact).padEnd(42)} ${s.status.padEnd(24)} ${s.refreshTokenExpires ? `refresh until ${day(s.refreshTokenExpires)}` : ""}`.trimEnd());
    const more = result.shops.filter((s) => needsAction(s.status) || s.status === STATUS.readyRefreshSoon).length - shown.length;
    if (more > 0) out.push(`  … and ${more} more (use --json for the full list)`);
  }
  if (project.length) {
    out.push("", "Project:");
    for (const c of project) out.push(`  ${c.ok === true ? "ok  " : c.ok === false ? (c.required ? "FIX " : "note") : c.required ? "?   " : "info"} ${c.detail}`);
  }
  for (const n of notes) out.push("", `Note: ${n}`);
  return out.join("\n");
}

export function toMarkdown(result, { redact = false, project = [], notes = [] } = {}) {
  const d = result.deadlines;
  const lines = [
    "# Expiring offline token readiness",
    "",
    `Checked ${result.checkedAt.slice(0, 10)}. ${result.totals.shopsNeedingAction ? `**${result.totals.shopsNeedingAction} of ${result.totals.shops} shops need action.**` : result.ready ? `**All ${result.totals.shops} shops have expiring tokens.**` : "**No offline sessions to judge.**"}`,
    "",
    "| Date | What happens to apps still on non-expiring tokens | Days left |",
    "| --- | --- | --- |",
    `| ${d.delist.date} | Delisted from the App Store, no new installs | ${d.delist.daysLeft} |`,
    `| ${d.warning.date} | Merchants see a warning in the Shopify admin | ${d.warning.daysLeft} |`,
    `| ${d.rejected.date} | Admin API requests return 403 | ${d.rejected.daysLeft} |`,
    "",
    "| Status | Shops |",
    "| --- | --- |",
    ...ORDER.filter((st) => result.counts[st]).map((st) => `| ${describe(st)} | ${result.counts[st]} |`),
  ];
  const act = result.shops.filter((s) => needsAction(s.status) || s.status === STATUS.readyRefreshSoon);
  if (act.length) {
    lines.push("", "| Shop | Status | Refresh token until |", "| --- | --- | --- |");
    for (const s of act) lines.push(`| ${label(s.shop, redact)} | ${s.status} | ${day(s.refreshTokenExpires)} |`);
  }
  if (project.length) {
    lines.push("", "| Project check | Result |", "| --- | --- |");
    for (const c of project) lines.push(`| ${c.id}${c.required ? "" : " (optional)"} | ${c.ok === true ? "ok" : c.ok === false ? (c.required ? "fix" : "optional") : c.required ? "unknown" : "info"}: ${c.detail} |`);
  }
  for (const n of notes) lines.push("", `> ${n}`);
  return lines.join("\n");
}
