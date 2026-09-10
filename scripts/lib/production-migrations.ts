const productionMigrationFileNamePattern = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/u

export interface ProductionMigrationFileName {
  sequence: number
  sequenceText: string
}

export function parseProductionMigrationFileName(
  name: string,
): ProductionMigrationFileName | undefined {
  const match = productionMigrationFileNamePattern.exec(name)
  if (!match?.[1]) return undefined

  return {
    sequence: Number(match[1]),
    sequenceText: match[1],
  }
}

export function isProductionMigrationFileName(name: string): boolean {
  return parseProductionMigrationFileName(name) !== undefined
}
