import { z } from "@hono/zod-openapi"
import type { Context } from "hono"

import {
  problemTypeRegistry,
  problemTypeUri,
  type ProblemSlug,
} from "./problem-registry"
import type { AppBindings } from "./types"

const canonicalProblemTypePattern =
  /^https:\/\/auth\.eruoo\.me\/problems\/[a-z0-9]+(?:-[a-z0-9]+)*$/

export const validationIssueSchema = z
  .object({
    detail: z.string(),
    location: z.enum(["body", "header", "path", "query"]),
    pointer: z.string(),
  })
  .strict()
  .openapi("ValidationIssue")

export const problemSchema = z
  .object({
    detail: z.string(),
    errors: z.array(validationIssueSchema).optional(),
    requestId: z.string(),
    status: z.int(),
    title: z.string(),
    type: z.string().url().openapi({
      description:
        "Canonical problem type URI in the https://auth.eruoo.me/problems/ namespace.",
      pattern: canonicalProblemTypePattern.source,
    }),
  })
  .strict()
  .openapi("Problem")

export interface ProblemOptions {
  detail: string
  errors?: Array<z.infer<typeof validationIssueSchema>>
  slug: ProblemSlug
}

export function problem(
  context: Context<AppBindings>,
  options: ProblemOptions,
): Response {
  const definition = problemTypeRegistry[options.slug]
  const body = problemSchema.parse({
    detail: options.detail,
    errors: options.errors,
    requestId: context.get("requestId"),
    status: definition.status,
    title: definition.title,
    type: problemTypeUri(options.slug),
  })

  return context.json(body, definition.status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
  })
}
