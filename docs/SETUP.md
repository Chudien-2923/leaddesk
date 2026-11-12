# Local setup

This is a local reference app, not a cloud deployment template. Use accounts/projects you control and are authorized to test. No credentials, databases, customer records or model weights are supplied.

## 1. Install and run checks

Use Node.js 24+ and npm. Start Docker for the isolated PostgreSQL tests.

```sh
npm ci
sh scripts/check.sh
```

`npm ci` applies the checked-in Transformers.js declaration patch. The gate generates Next.js route types before strict typechecking so it also works on a clean clone. It must not use your real database or call real AI/CRM/Calendar services during automated tests. A missing Docker daemon is an error, not permission to skip DB tests or connect them to a real `DATABASE_URL`.

## 2. Prepare environment configuration

```sh
cp .env.example .env.local
```

Edit `.env.local` locally; all empty values must come from your own setup. Do not copy another operator's configuration or check populated values into Git.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Server-side PostgreSQL connection; never a client-exposed variable |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase project and public Auth client configuration |
| `ADMIN_USER_ID` | Exact UUID of the one Supabase Auth user allowed to administer the app |
| `HUBSPOT_ACCESS_TOKEN` | Separately authorized HubSpot developer-test integration |
| `GOOGLE_CALENDAR_ID` | Dedicated calendar, never `primary` |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Your Google OAuth client for manual authorization |
| `KNOWLEDGE_MIN_SIMILARITY` | Optional retrieval threshold; default0.832 has only a small English calibration |

Database, administrator authentication, CRM and Calendar validate their own configuration at the relevant capability boundary. Starting the page does not prove that each service is ready.

## 3. PostgreSQL and Supabase Auth

Create your own isolated PostgreSQL/Supabase project. The app uses PostgreSQL/pgvector directly through `pg`; do not expose its backend connection string to the browser. Administrator login uses Supabase Auth with the exact `ADMIN_USER_ID` allowlist, not an arbitrary client-side role claim.

For a **new empty authorized database**, apply every file in `supabase/migrations/` in filename order using a privileged migration connection or SQL editor. The files create the schema, pgvector extension and access-control boundaries. Do not blindly rerun them over an existing project or assume a migration-history service is included.

Use an authenticated, certificate-verified server connection. For hosted PostgreSQL, configure the provider's official CA/`sslrootcert` and `sslmode=verify-full`; do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`. Keep credentials/CA files outside Git, for example under ignored `.local/`. The operation smoke runner rejects URL authority/query overrides and checks its explicitly approved targets.

The server database role needs the intended backend privileges and a pool capable of the workflow lock/checkpoint connections. PostgreSQL grants/RLS do not replace the HTTP ownership/admin checks. Supabase's general Data API is not required for conversation CRUD by this app.

Create the administrator Auth user in your own Supabase project, set its exact UUID in `.env.local`, and sign in through `/login`. This is not a public administrator-registration feature.

## 4. Explicitly prepare local embeddings

```sh
npm run prepare:embeddings
```

This command downloads the pinned E5 artifacts and writes a manifest under ignored `.local/models/`. The runtime checks local artifacts and does not download a model or substitute fake vectors when the cache is missing/corrupt.

The pinned model is `Xenova/multilingual-e5-small`, revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, fp32,384dimensions. Model weights are not distributed with this repository. Review the upstream model terms before downloading or redistributing them. See THIRD_PARTY_NOTICES.md.

## 5. Publish synthetic knowledge

Only after applying migrations and preparing E5, seed a **new authorized test database**:

```sh
node --env-file=.env.local --conditions=react-server --import tsx scripts/seed-knowledge.ts
```

This is a database write/publication, not a read-only health check. Do not replay it just because the UI is unavailable. A failed publication must not be treated as a ready release. The default dataset is synthetic English agency content; prices are VND and times use `Asia/Ho_Chi_Minh`.

Alternatively use the authenticated Knowledge UI for subsequent document/policy revisions. Published policy revisions are immutable; use a new revision ID when the policy content changes rather than editing old database rows.

## 6. Configure your own OMP model access

Install/authenticate a compatible OMP CLI independently; follow its upstream documentation and your providers' terms. The app calls `omp auth-gateway stdio` through an isolated temporary configuration and validates requested/reported model provenance. It does not load a coding-agent session, private project instructions or tools into the product AI.

The configured primary/fallback selectors must actually be supported by your account. There are no credentials or credits bundled in this repository and no route that silently purchases paid API access. Do not edit accounts/quota to bypass a provider refusal.

An optional real model check is:

```sh
npm run smoke:models
```

Unlike `npm test`, this invokes your authenticated model access and consumes upstream usage. Run it only deliberately. Migrating this code to direct provider API keys is separate implementation work, not an existing deployment setting.

## 7. Optional HubSpot integration

Use a developer-test account and the minimal Contact/Note scopes needed by the code, not a production customer portal. Set `HUBSPOT_ACCESS_TOKEN` locally. The Contact and Note must both be confirmed saved, with the relevant consent/facts/policy version, before the UI offers calendar times.

A human-review request is saved in the app's own inbox with separate consent; it does not create a CRM record by itself or promise staff notification/read status.

## 8. Optional Google Calendar integration

Create a dedicated calendar and an OAuth client that you are allowed to use. Set the Calendar/OAuth variables locally, then manually authorize:

```sh
node --env-file=.env.local --import tsx scripts/calendar-auth.ts
```

The script may ask you to open an authorization URL yourself. It stores credentials/tokens under ignored `.local/google/` with restrictive permissions. Never upload that directory. Authorization/refresh may change those local token files; it is not part of an anonymous health check.

The booking client requires FreeBusy and owned-event access. Appointments are30minutes on the policy grid; choosing a time is not a booking. Only final confirmation can create an event. No attendees/Meet/invitations are added. An uncertain outcome requires read-back of the original operation/event rather than a fresh booking.

## 9. Start locally

```sh
npm run dev
# Or, after a successful build:
npm start
```

Both commands bind to loopback by default. The usual URL is `http://127.0.0.1:3000`; use an explicit `--port` if needed and preserve the same origin for a saved browser consultation. Work from this repository root so local cache and credential paths resolve consistently.

Without a visitor account, browser/profile cookie separation determines access to a conversation. Do not promise cross-browser synchronization or retention after a browser session ends. Only bounded context is sent to the model; saved transcript is not automatic unlimited model memory.

## 10. Optional operation smoke

`scripts/smoke-local.ts` is an operator acceptance utility, not a default setup command. Explicitly provide the correct loopback `--base-url`, private state path and approved test project/portal/calendar flags. Default/preflight mode does not authorize mutations. Fresh writes additionally require `--allow-test-writes` and `--server-uses-this-env` plus a separately approved record budget.

Never import cookies from a personal browser, change a frozen state origin/key/payload to escape uncertainty, or use another project's identifiers. The fixture IDs in tests are synthetic, not accounts you can access. Do not run fresh smoke against a shared or production account to make a screenshot.
