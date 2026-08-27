export type AuthMethod = "apiKey" | "oauth" | "session"

export interface Principal {
  subject: string
  authMethod: AuthMethod
  clientId?: string
  scopes: string[]
  permissions: string[]
  credentialId?: string
  reauthenticatedAt?: number
}
