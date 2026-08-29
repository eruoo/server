export const e2eBrowserHost = "localhost"

export const e2eServerHost = "::"

export const e2eReadinessHost = "127.0.0.1"

export const e2ePort = 41_731

export const e2eOrigin = `http://${e2eBrowserHost}:${e2ePort}`

export const e2eReadinessOrigin = `http://${e2eReadinessHost}:${e2ePort}`

export const e2eBootstrapPath = "/api/__e2e/bootstrap"

export const e2eCurrentSessionPath = "/api/__e2e/session"

export const e2eStaleSessionPath = "/api/__e2e/session/stale"

export const e2eBootstrapToken =
  "synthetic-owner-bootstrap-token-used-only-in-browser-tests"
