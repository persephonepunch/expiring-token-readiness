# Expiring Token Readiness

Shopify requires every public app that calls the Admin API to use **expiring offline access tokens by 1 January 2027**. Apps that haven't migrated are delisted that day, merchants see a warning from 15 January, and from 1 April 2027 their Admin API requests return 403 ([Shopify, October 2026](https://shopify.dev/changelog/blog/app-security-updates-october-2026)).

`etr` tells you which of your app's shops are ready. It reads your session data locally, sends nothing anywhere, and never prints a token.

## Run it

Node 22.5 or later. From this folder:

```sh
# Shopify app template (Prisma + SQLite)
node bin/etr.js --sqlite path/to/app/prisma/dev.sqlite --project path/to/app

# Any other store: export your sessions as JSON or CSV first
node bin/etr.js --json sessions.json
node bin/etr.js --csv sessions.csv --format markdown --redact > readiness.md
```

Exit code `0` means ready, `1` means action needed, `2` means bad input, so it can gate a CI job.

## What it reads

Per session, Shopify's own field names (or their snake_case forms): `shop`, `isOnline`, `accessToken`, `refreshToken`, `expires`, `refreshTokenExpires`. Only the *presence* of a token is used. With `--sqlite` the query asks the database whether each token is present, so token values are never even loaded. An export can carry `hasAccessToken` / `hasRefreshToken` booleans instead of tokens.

## What it reports

| Status | Meaning | Action |
| --- | --- | --- |
| `migrate` | Offline session with no refresh token and no expiry: a non-expiring token | Run the token exchange with `expiring=1` |
| `broken-no-refresh-token` | An expiring token was stored without its refresh token | If you kept the original non-expiring token, repeat the exchange within 7 days to get the same pair back; otherwise the merchant reopens the app |
| `broken-refresh-expired` | The refresh token has expired | The merchant must reopen the app |
| `ready-refresh-soon` | Expiring, but the refresh token expires within 14 days | Make sure your refresh job is running |
| `ready` | Expiring token with a valid refresh token | None |
| `online` | Online session | Not affected by the deadline |

A shop's verdict comes from its offline session, so online sessions never hide a shop that still needs to migrate.

With `--project`, it also checks your code:

- `future: { expiringOfflineAccessTokens: true }` in `shopifyApp()` (required by Shopify's [migration guide](https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens))
- `refreshToken` and `refreshTokenExpires` on the Prisma `Session` model
- your Shopify app library versions (for reference)
- `[network_access]` in `shopify.app.toml` (optional)

`--redact` replaces shop domains with short hashes, so a report can be shared without naming merchants.

## What it doesn't do

It doesn't call Shopify. A stored record says what your app *thinks* it holds; the definitive test is an Admin API call, which returns 403 with "Non-expiring access tokens are no longer accepted for the Admin API" for a non-expiring token once enforcement starts. It doesn't migrate anything either: the migration kit and the BYO Xano + Cloudflare vault are the next parts of this project.

## Tests

```sh
npm test
```

## License

MIT. See [LICENSE](LICENSE).
