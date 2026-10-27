#!/usr/bin/env node
// etr — check a Shopify app's readiness for expiring offline access tokens (1 January 2027).
// Reads locally, sends nothing anywhere, and never prints a token.
//
// Exit codes: 0 ready · 1 action needed · 2 bad input

import { resolve } from "node:path";
import { check } from "../src/classify.js";
import { readCsv, readJson, readSqlite } from "../src/sources.js";
import { scanProject } from "../src/project.js";
import { toJson, toMarkdown, toText } from "../src/report.js";

const HELP = `Usage: etr [source] [options]

Sources (one):
  --sqlite <file>     Prisma SQLite database (Shopify template: prisma/dev.sqlite)
  --json <file>       JSON array of sessions, or { "sessions": [...] }
  --csv <file>        CSV export with a header row

Options:
  --table <name>      Session table name for --sqlite (default: Session)
  --project <dir>     Also check the app's code: future flag, Prisma columns, libraries
  --format <f>        text (default), markdown, or json
  --redact            Replace shop domains with short hashes, to share a report
  --now <date>        Evaluate as of this date (ISO), for testing
  -h, --help          Show this help

Fields read per session (Shopify's names, or snake_case): shop, isOnline, accessToken,
refreshToken, expires, refreshTokenExpires. Only the presence of a token is used.`;

function parseArgs(argv) {
  const o = { format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { const v = argv[++i]; if (v == null) throw new Error(`${a} needs a value`); return v; };
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--sqlite") o.sqlite = next();
    else if (a === "--json") o.json = next();
    else if (a === "--csv") o.csv = next();
    else if (a === "--table") o.table = next();
    else if (a === "--project") o.project = next();
    else if (a === "--format") o.format = next();
    else if (a === "--redact") o.redact = true;
    else if (a === "--now") o.now = next();
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`etr: ${e.message}\n\n${HELP}`); return 2; }
  if (o.help) { console.log(HELP); return 0; }
  const sources = [o.sqlite, o.json, o.csv].filter(Boolean);
  if (sources.length !== 1) { console.error(`etr: give exactly one of --sqlite, --json, --csv\n\n${HELP}`); return 2; }
  if (!["text", "markdown", "json"].includes(o.format)) { console.error("etr: --format must be text, markdown or json"); return 2; }
  const now = o.now ? Date.parse(o.now) : Date.now();
  if (Number.isNaN(now)) { console.error("etr: --now must be a date"); return 2; }

  let data, project = [];
  try {
    data = o.sqlite ? await readSqlite(resolve(o.sqlite), o.table) : o.json ? readJson(resolve(o.json)) : readCsv(resolve(o.csv));
    if (o.project) project = scanProject(resolve(o.project));
  } catch (e) { console.error(`etr: ${e.message}`); return 2; }
  if (!data.records.length) { console.error("etr: the source has no sessions"); return 2; }

  const result = check(data.records, now);
  const opts = { redact: !!o.redact, project, notes: data.notes };
  console.log(o.format === "json" ? toJson(result, opts) : o.format === "markdown" ? toMarkdown(result, opts) : toText(result, opts));

  const projectBlocking = project.some((c) => c.required && c.ok === false);
  return result.totals.shopsNeedingAction || projectBlocking ? 1 : 0;
}

process.exitCode = await main();
