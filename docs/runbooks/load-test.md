# Load test and capacity

`npm run load:test` generates a synthetic organization, ingests a large synthetic inbox through the real sync path, analyses it with the offline heuristic provider (no model is contacted), then signs in and requests the main pages under concurrency. No new dependency: it uses the project's own modules and `fetch`.

```
npm run load:test -- [--messages 3000] [--analysis-concurrency 4] [--http-requests 300] [--http-concurrency 20] [--base-url http://localhost:3000]
                     [--no-http] [--mint-session] [--keep] [--assert]
```
- Phase 1 (ingestion, analysis) needs only Postgres and Redis. Phase 2 (pages) needs a running server. Against `npm run dev` it signs in with dev login. Against a **production build** (`next start`, which refuses dev login) pass `--mint-session`, which signs a session cookie from this machine's `AUTH_SECRET`; it works only against a server sharing that secret, i.e. your own local or staging build. Start that server with `AUTH_URL=http://localhost:<port> AUTH_DEV_LOGIN=false`.
- `--assert` turns generous floors into an exit code (ingestion at least 50 messages/s, analysis at least 10/s, page p95 under 3 s, no errors, nothing still failing after retries or deferred). They catch an order-of-magnitude regression; they are not a benchmark.
- It deletes the synthetic organization afterwards (`--keep` to inspect it) and prints counts and timings only.

## Results (Sprint 13, 2026-11-06)

A developer laptop, Postgres and Redis in Docker, production build, 3,000 synthetic messages in 1,200 conversations (1,200 tracked items), 20 concurrent users.

| Measure | Result |
|---|---|
| Ingestion (real sync path, 100 per page) | about 65–80 messages/s (3,000 in 38–47 s) |
| Analysis (offline provider, 4 concurrent) | about 50–120 messages/s, p95 about 200 ms per message; 5,500 analysis runs, no failures or abandoned jobs |
| Pages, production build, 20 concurrent, 300 requests | **47 requests/s, p50 404 ms, p95 597 ms, p99 626 ms, 0 errors** (dashboard, items, approvals, review, notifications) |
| Pages, dev server, 20 concurrent | 3 requests/s, p50 6.2 s: the dev server renders on demand in one process; not representative |
| LLM tokens used by the 3,000-message run | about 4.5 million (the default daily budget is 2 million per organization) |

What it found and what was done about it (all fixed in Sprint 13, each with tests):
1. **Database connection pool too small.** At the library default of 10 connections, 20 concurrent users made 94% of requests fail ("Unable to start a transaction in the given time"). `DB_POOL_MAX` (default 20) and `DB_TX_MAX_WAIT_MS` (default 10 s) are now configurable. After: 0 errors.
2. **The review queue page listed every open task.** With 1,200 items (each needing an owner) it rendered 1,200 rows and took 3 s alone. It now shows the oldest 100 and says "Showing the oldest 100 of N" (N counts only tasks the viewer may see, so it never reveals other teams' work).
3. **Production sign-in could not work at all** (`trustHost` was set to `false` explicitly, so Auth.js rejected every host, even with `AUTH_URL` set). Found while trying to load-test a production build. Fixed, and production now requires `AUTH_URL`.
4. **The LLM token budget deferred about a quarter of the analyses** in the first run: it is working as designed (a cost guard), and is why the load test lifts it for its throwaway organization.

## What it does not tell you

- Real model latency and cost: the heuristic provider answers instantly. Analysis throughput with `LLM_PROVIDER=claude` is bounded by the provider and by `ANALYZE_RATE_PER_MINUTE`.
- Real provider behaviour: Gmail and Chat are exercised against fakes. Quotas, rate limits and latency of the real APIs are unmeasured.
- Scale beyond a few thousand items: the dashboard reads at most the 2,000 most recent items per request (snapshots are the planned answer), and the review queue reads at most 5,000 open tasks.
- A multi-node deployment: one web process and one worker were measured.
