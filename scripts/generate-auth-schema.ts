import { createAuthSchemaSql } from "./lib/auth-schema"

process.stdout.write(await createAuthSchemaSql())
