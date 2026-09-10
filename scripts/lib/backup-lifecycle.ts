import { z } from "zod"
const lifecycleSchema = z.object({
  rules: z.array(
    z
      .object({
        id: z.string(),
        enabled: z.boolean(),
        conditions: z.object({ prefix: z.string() }),
        deleteObjectsTransition: z
          .object({
            condition: z
              .object({ type: z.string(), maxAge: z.number().optional() })
              .passthrough(),
          })
          .optional(),
        storageClassTransitions: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  ),
})
export function verifyBackupLifecycle(value: unknown): void {
  const { rules } = lifecycleSchema.parse(value)
  const active = rules.filter(
    (rule) =>
      rule.enabled &&
      ("d1/daily/".startsWith(rule.conditions.prefix) ||
        rule.conditions.prefix.startsWith("d1/daily/")),
  )
  const deletion = active.filter((rule) => rule.deleteObjectsTransition)
  if (
    deletion.length !== 1 ||
    deletion[0]!.conditions.prefix !== "d1/daily/" ||
    deletion[0]!.deleteObjectsTransition!.condition.type !== "Age" ||
    deletion[0]!.deleteObjectsTransition!.condition.maxAge !== 30 * 86400 ||
    active.some((rule) => rule.storageClassTransitions?.length)
  )
    throw new Error(
      "Backup bucket must have exactly one 30-day daily-prefix expiration rule and retain Standard storage",
    )
}
