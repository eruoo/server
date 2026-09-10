import { expect, it } from "vitest"

import { verifyBackupLifecycle } from "./backup-lifecycle"
const rule = {
  id: "daily",
  enabled: true,
  conditions: { prefix: "d1/daily/" },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: 2592000 } },
}
it("accepts the dedicated backup lifetime and harmless multipart policy", () => {
  expect(() =>
    verifyBackupLifecycle({
      rules: [
        rule,
        {
          id: "uploads",
          enabled: true,
          conditions: { prefix: "" },
          abortMultipartUploadsTransition: {
            condition: { type: "Age", maxAge: 86400 },
          },
        },
      ],
    }),
  ).not.toThrow()
})
it("rejects missing, shorter, overlapping or storage-class transitions before any deployment", () => {
  for (const rules of [
    [],
    [{ ...rule, enabled: false }],
    [{ ...rule, conditions: { prefix: "" } }],
    [
      {
        ...rule,
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
      },
    ],
    [rule, { ...rule, id: "overlap", conditions: { prefix: "d1/" } }],
    [{ ...rule, storageClassTransitions: [{}] }],
  ])
    expect(() => verifyBackupLifecycle({ rules })).toThrow(
      "Backup bucket must have exactly one",
    )
})
