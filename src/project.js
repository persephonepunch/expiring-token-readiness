// Check an app's source for what the migration needs, without running anything.
//
// Required (from Shopify's migration guide):
//   - shopifyApp({ future: { expiringOfflineAccessTokens: true } }) in the app's server setup
//     (Shopify app templates: app/shopify.server.ts), then `shopify app deploy`
// Needed to keep the chain alive:
//   - somewhere to store the refresh token: Prisma Session.refreshToken + refreshTokenExpires
// Reported for context, not judged:
//   - the Shopify app library versions, and whether shopify.app.toml declares [network_access]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CODE = /\.(m?[jt]sx?|cjs)$/;
const SKIP = new Set(["node_modules", ".git", "build", "dist", ".cache", ".shopify", "public"]);

function* walk(dir, depth = 0) {
  if (depth > 5) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (CODE.test(e.name)) yield p;
  }
}

const readSmall = (p) => { try { return statSync(p).size <= 512 * 1024 ? readFileSync(p, "utf8") : ""; } catch { return ""; } };

export function scanProject(root) {
  if (!existsSync(root)) throw new Error(`project folder not found: ${root}`);
  const checks = [];

  // 1. The template flag, in whichever file calls shopifyApp().
  const callers = [];
  for (const dir of ["app", "src", "server", "web", "."]) {
    const d = join(root, dir);
    if (!existsSync(d)) continue;
    for (const f of walk(d, dir === "." ? 4 : 0)) {
      const src = readSmall(f);
      if (/\bshopifyApp\s*\(/.test(src) && !callers.some((c) => c.file === f)) callers.push({ file: f, src });
    }
  }
  const flagged = callers.filter((c) => /expiringOfflineAccessTokens\s*:\s*true/.test(c.src));
  checks.push({
    id: "future-flag",
    required: true,
    ok: callers.length ? flagged.length > 0 : null,
    detail: !callers.length
      ? "No shopifyApp() call found; if the app doesn't use the Shopify app library, check its OAuth code requests expiring=1"
      : flagged.length
        ? `future.expiringOfflineAccessTokens is on in ${relative(root, flagged[0].file)}`
        : `Add future: { expiringOfflineAccessTokens: true } to shopifyApp() in ${relative(root, callers[0].file)}, then run shopify app deploy`,
  });

  // 2. Somewhere to keep refresh tokens.
  const schemaPath = ["prisma/schema.prisma", "schema.prisma"].map((p) => join(root, p)).find(existsSync);
  if (schemaPath) {
    const schema = readSmall(schemaPath);
    const model = /model\s+Session\s*\{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    const okCols = /\brefreshToken\s+String\?/.test(model) && /\brefreshTokenExpires\s+DateTime\?/.test(model);
    checks.push({
      id: "prisma-columns",
      required: true,
      ok: model ? okCols : null,
      detail: !model
        ? `${relative(root, schemaPath)} has no Session model; check your session storage keeps refreshToken and refreshTokenExpires`
        : okCols
          ? "Prisma Session model has refreshToken and refreshTokenExpires"
          : "Add refreshToken String? and refreshTokenExpires DateTime? to model Session, then run a Prisma migration",
    });
  } else {
    checks.push({ id: "prisma-columns", required: true, ok: null, detail: "No Prisma schema found; check your session storage keeps refreshToken and refreshTokenExpires" });
  }

  // 3. Library versions, for context.
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { /* reported below */ }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const libs = Object.keys(deps).filter((k) => /^@shopify\/(shopify-app-|shopify-api)/.test(k)).map((k) => `${k} ${deps[k]}`);
    checks.push({ id: "libraries", required: false, ok: null, detail: libs.length ? libs.join(", ") : "No Shopify app libraries in package.json" });
  }

  // 4. Network access declarations (optional in the October 2026 update).
  const tomls = existsSync(root) ? readdirSync(root).filter((f) => /^shopify\.app(\.[\w-]+)?\.toml$/.test(f)) : [];
  if (tomls.length) {
    const declared = tomls.filter((f) => /^\s*\[network_access\]/m.test(readSmall(join(root, f))));
    checks.push({
      id: "network-access",
      required: false,
      ok: declared.length === tomls.length,
      detail: declared.length === tomls.length
        ? `[network_access] declared in ${declared.join(", ")}`
        : `Optional: declare [network_access] in ${tomls.filter((f) => !declared.includes(f)).join(", ")}`,
    });
  }

  return checks;
}
