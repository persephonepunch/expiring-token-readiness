import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { STATUS, check, classify, normalize, toTime } from "../src/classify.js";
import { parseCsv, readSqlite } from "../src/sources.js";
import { scanProject } from "../src/project.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const DAY = 864e5;
const BIN = fileURLToPath(new URL("../bin/etr.js", import.meta.url));
// Distinctive fake secrets: no output may ever contain them.
const ACCESS = "shpat_FAKE_ACCESS_never_print_0001";
const REFRESH = "shprt_FAKE_REFRESH_never_print_0002";
const tmp = () => mkdtempSync(join(tmpdir(), "etr-"));

test("each stored shape gets the right status", () => {
  const c = (r) => classify(normalize(r), NOW);
  assert.equal(c({ shop: "a", isOnline: false, accessToken: ACCESS }), STATUS.migrate);
  assert.equal(c({ shop: "a", isOnline: false, accessToken: ACCESS, refreshToken: REFRESH, expires: NOW + DAY, refreshTokenExpires: NOW + 90 * DAY }), STATUS.ready);
  assert.equal(c({ shop: "a", isOnline: false, accessToken: ACCESS, refreshToken: REFRESH, refreshTokenExpires: NOW + 5 * DAY }), STATUS.readyRefreshSoon);
  assert.equal(c({ shop: "a", isOnline: false, accessToken: ACCESS, refreshToken: REFRESH, refreshTokenExpires: NOW - DAY }), STATUS.brokenRefreshExpired);
  assert.equal(c({ shop: "a", isOnline: false, accessToken: ACCESS, expires: NOW + DAY }), STATUS.brokenNoRefreshToken);
  assert.equal(c({ shop: "a", isOnline: true, accessToken: ACCESS, expires: NOW + DAY }), STATUS.online);
  assert.equal(c({ shop: "a", isOnline: false }), STATUS.unknown);
  // An expired ACCESS token with a valid refresh token is fine: it refreshes on next use.
  assert.equal(c({ shop: "a", accessToken: ACCESS, refreshToken: REFRESH, expires: NOW - DAY, refreshTokenExpires: NOW + 60 * DAY }), STATUS.ready);
});

test("dates and flags in every form stores use", () => {
  assert.equal(toTime("2026-10-27T12:00:00Z"), NOW);
  assert.equal(toTime(NOW), NOW); // Prisma on SQLite: milliseconds
  assert.equal(toTime(NOW / 1000), NOW); // seconds
  assert.equal(toTime(String(NOW)), NOW);
  assert.equal(toTime(""), null);
  assert.equal(toTime("not a date"), null);
  assert.equal(normalize({ is_online: "1" }).online, true);
  assert.equal(normalize({ refresh_token: "" }).hasRefreshToken, false);
  assert.equal(normalize({ has_refresh_token: "true" }).hasRefreshToken, true);
});

test("a shop's verdict is its offline session's; online rows don't hide a shop that must migrate", () => {
  const r = check([
    { shop: "B.myshopify.com", isOnline: true, accessToken: ACCESS, expires: NOW + DAY },
    { shop: "b.myshopify.com", isOnline: false, accessToken: ACCESS },
    { shop: "c.myshopify.com", isOnline: false, accessToken: ACCESS, refreshToken: REFRESH, refreshTokenExpires: NOW + 60 * DAY },
  ], NOW);
  assert.equal(r.totals.shops, 2);
  assert.equal(r.totals.shopsNeedingAction, 1);
  assert.equal(r.shops[0].shop, "b.myshopify.com");
  assert.equal(r.shops[0].status, STATUS.migrate);
  assert.equal(r.ready, false);
  assert.equal(r.deadlines.delist.daysLeft, 66);
});

test("CSV: quotes, embedded commas and newlines, CRLF", () => {
  const rows = parseCsv('shop,note,isOnline\r\n"a.myshopify.com","x, ""y""\nz",0\r\nb.myshopify.com,,1\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, 'x, "y"\nz');
  assert.equal(rows[1].isOnline, "1");
});

test("SQLite: reads the Prisma Session table without ever selecting a token", async () => {
  const dir = tmp(), file = join(dir, "dev.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE "Session" (id TEXT PRIMARY KEY, shop TEXT, state TEXT, isOnline BOOLEAN, scope TEXT, expires DATETIME, accessToken TEXT, refreshToken TEXT, refreshTokenExpires DATETIME)`);
  const ins = db.prepare(`INSERT INTO "Session" VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run("offline_a", "a.myshopify.com", "", 0, "", null, ACCESS, null, null);
  ins.run("offline_b", "b.myshopify.com", "", 0, "", NOW + DAY, ACCESS, REFRESH, NOW + 60 * DAY);
  db.close();
  const { records, notes } = await readSqlite(file);
  assert.equal(records.length, 2);
  assert.ok(!JSON.stringify(records).includes("FAKE"), "a token value reached memory");
  assert.equal(notes.length, 0);
  const r = check(records, NOW);
  assert.deepEqual(r.shops.map((s) => [s.shop, s.status]), [["a.myshopify.com", STATUS.migrate], ["b.myshopify.com", STATUS.ready]]);
});

test("SQLite: an older schema without refresh columns is read and flagged", async () => {
  const dir = tmp(), file = join(dir, "old.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE "Session" (id TEXT PRIMARY KEY, shop TEXT, isOnline BOOLEAN, expires DATETIME, accessToken TEXT)`);
  db.prepare(`INSERT INTO "Session" VALUES (?,?,?,?,?)`).run("o", "a.myshopify.com", 0, null, ACCESS);
  db.close();
  const { records, notes } = await readSqlite(file);
  assert.equal(check(records, NOW).shops[0].status, STATUS.migrate);
  assert.match(notes[0], /no refreshToken \/ refreshTokenExpires columns/);
});

test("project scan: flag, Prisma columns, libraries, network access", () => {
  const root = tmp();
  mkdirSync(join(root, "app")); mkdirSync(join(root, "prisma"));
  writeFileSync(join(root, "app/shopify.server.ts"), "const shopify = shopifyApp({ apiKey: 'x' });");
  writeFileSync(join(root, "prisma/schema.prisma"), "model Session {\n  id String @id\n  accessToken String\n}\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@shopify/shopify-app-react-router": "^1.0.0" } }));
  writeFileSync(join(root, "shopify.app.toml"), 'client_id = "x"\n');
  let checks = Object.fromEntries(scanProject(root).map((c) => [c.id, c]));
  assert.equal(checks["future-flag"].ok, false);
  assert.match(checks["future-flag"].detail, /app\/shopify\.server\.ts/);
  assert.equal(checks["prisma-columns"].ok, false);
  assert.match(checks.libraries.detail, /shopify-app-react-router/);
  assert.equal(checks["network-access"].ok, false);

  writeFileSync(join(root, "app/shopify.server.ts"), "const shopify = shopifyApp({ future: { expiringOfflineAccessTokens: true } });");
  writeFileSync(join(root, "prisma/schema.prisma"), "model Session {\n  id String @id\n  refreshToken  String?\n  refreshTokenExpires DateTime?\n}\n");
  writeFileSync(join(root, "shopify.app.toml"), 'client_id = "x"\n\n[network_access]\n');
  checks = Object.fromEntries(scanProject(root).map((c) => [c.id, c]));
  assert.equal(checks["future-flag"].ok, true);
  assert.equal(checks["prisma-columns"].ok, true);
  assert.equal(checks["network-access"].ok, true);
});

test("CLI: exit 1 when action is needed, 0 when ready, 2 on bad input", () => {
  const dir = tmp();
  const bad = join(dir, "bad.json"), good = join(dir, "good.json");
  writeFileSync(bad, JSON.stringify([{ shop: "secret-merchant.myshopify.com", isOnline: false, accessToken: ACCESS }]));
  writeFileSync(good, JSON.stringify({ sessions: [{ shop: "ok.myshopify.com", isOnline: false, accessToken: ACCESS, refreshToken: REFRESH, refreshTokenExpires: "2027-03-01" }] }));
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a, "--now", "2026-10-27"], { encoding: "utf8" });

  const r1 = run("--json", bad);
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /ACTION NEEDED: 1 of 1 shops/);
  const r2 = run("--json", good, "--format", "json");
  assert.equal(r2.status, 0);
  assert.equal(JSON.parse(r2.stdout).ready, true);
  assert.equal(run("--csv", join(dir, "missing.csv")).status, 2);
  assert.equal(run().status, 2);
});

test("CLI output never contains a token, in any format", () => {
  const dir = tmp(), f = join(dir, "s.json");
  writeFileSync(f, JSON.stringify([
    { shop: "secret-merchant.myshopify.com", isOnline: false, accessToken: ACCESS },
    { shop: "two.myshopify.com", isOnline: false, accessToken: ACCESS, refreshToken: REFRESH, refreshTokenExpires: "2026-11-01" },
  ]));
  for (const fmt of ["text", "markdown", "json"]) {
    const r = spawnSync(process.execPath, [BIN, "--json", f, "--format", fmt, "--redact", "--now", "2026-10-27"], { encoding: "utf8" });
    assert.equal(r.status, 1, fmt);
    assert.ok(!r.stdout.includes("FAKE"), `${fmt} output contains a token`);
    assert.ok(!r.stdout.includes("secret-merchant"), `${fmt} output names a shop despite --redact`);
    assert.match(r.stdout, /shop-[0-9a-f]{10}/, fmt);
  }
});
