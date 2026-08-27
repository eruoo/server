export type PasskeyCredentialSignalOutcome =
  | "failed"
  | "requested"
  | "unsupported"

interface SignalUnknownPasskeyCredentialInput {
  credentialId: string
  rpId: string
}

export async function signalUnknownPasskeyCredential({
  credentialId,
  rpId,
}: SignalUnknownPasskeyCredentialInput): Promise<PasskeyCredentialSignalOutcome> {
  if (
    typeof PublicKeyCredential === "undefined" ||
    typeof PublicKeyCredential.signalUnknownCredential !== "function"
  ) {
    return "unsupported"
  }

  try {
    await PublicKeyCredential.signalUnknownCredential({ credentialId, rpId })
    return "requested"
  } catch {
    return "failed"
  }
}
