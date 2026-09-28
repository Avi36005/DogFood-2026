# Architecture

Forgeboard is one Node process and one SQLite file. It renders HTML on the server, answers JSON
on the same routes' domain functions, and needs nothing from the network.

```
            docker compose up
┌──────────────────────────────────────────────────────────────────────────┐
│ container: node:24-alpine, runs as user "node"                           │
│                                                                          │
│   node:http ──► http/app.ts ──► routes/*.ts ──► domain/*.ts ──► db/store  │
│                 security headers   parse, render   rules + authorization  │
│                 session lookup     pick HTML/JSON  one transaction each   │
│                 CSRF check                                                │
│                 error boundary ◄── HttpError / AccessDenied (audited)     │
│                                                                          │
│   volume /data ── forgeboard.db (SQLite, WAL) ── the only state there is  │
└──────────────────────────────────────────────────────────────────────────┘
        no egress, no second service, no API key, no npm install
```

## The request path

1. **`http/app.ts`** sets the security headers, then builds a `Ctx`. The `Ctx` holds the parsed
   URL, the cookies, the CSRF cookie and the server's clock reading for this request.
2. **Static files** (`/static/*`) are served from memory with a content hash in the URL, so a
   release is never hidden behind a cached stylesheet.
3. **The session cookie** is hashed and looked up. An unknown or expired token is simply no user.
4. **The router** matches method and path (`http/router.ts`, about 60 lines). For `POST`,
   **`ctx.verifyCsrf()`** runs *before* any handler, so no route can forget it.
5. **A route handler** (`routes/*.ts`) parses input and calls **one domain function**. It then
   renders a page (`views/*.ts`) or answers JSON, and redirects after a successful form post.
6. **The domain function** (`domain/*.ts`) takes an `Actor` (user, IP, server time). It checks
   authorization, then does its reads and writes in **one transaction**.
7. **Errors** become responses in one place, `fail()`:
   - `HttpError` keeps its status.
   - `ValidationError` re-renders the form with every field's message.
   - A database constraint violation becomes a 409 instead of a crash.
   - An `AccessDenied` is written to the audit trail *after* the transaction has rolled back,
     so a refused attempt is never lost with the work it tried to do.

