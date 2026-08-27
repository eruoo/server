import { expect, test } from "@playwright/test"

test("the pinned Scalar standalone bundle is served as a static JavaScript asset", async ({
  request,
}) => {
  const response = await request.get("/scalar/1.65.1/standalone.js")

  await expect(response).toBeOK()
  expect(response.headers()["content-type"]).toContain("application/javascript")
  expect(await response.text()).toContain("@scalar/api-reference 1.65.1")
})
