// Call only after the initiating flow has checked its generation/lifecycle.
export function redirectAuthenticationResult(data: unknown): boolean {
  if (
    typeof data !== "object" ||
    data === null ||
    !("redirect" in data) ||
    data.redirect !== true ||
    !("url" in data) ||
    typeof data.url !== "string"
  )
    return false
  const url = new URL(data.url, window.location.origin)
  if (!["http:", "https:"].includes(url.protocol)) return false
  window.location.assign(url.href)
  return true
}
