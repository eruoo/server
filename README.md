# eruoo-server

Personal identity, authorization, and API foundation for eruoo applications.
The service is designed for Cloudflare Workers and combines a Hono API,
Better Auth, D1, and a Vue management SPA.

The product and security contract lives in
[`docs/specs/foundation.md`](./docs/specs/foundation.md). Its implementation
boundary allows reversible local work to proceed while keeping production,
credentials, domains, paid services, and destructive actions behind explicit
owner authorization.

## Local development

Requirements: Node.js 24 and the pnpm version pinned by `packageManager`.

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm run db:migrate:local
pnpm run dev
```

Replace every placeholder in `.dev.vars` with local-only values. The file is
ignored by Git and must never be committed. See
[`docs/development.md`](./docs/development.md) for the complete workflow.

## Verification

```sh
pnpm run check
```

`check` is read-only with respect to remote Cloudflare resources. Database
migrations and deployment use separate, explicit commands. The independent
`release:preflight` command intentionally fails until production resource IDs
have been configured; it does not create or deploy those resources.

## License

[MIT](./LICENSE). Bundled font notices are listed in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
