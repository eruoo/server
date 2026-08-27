import { describe, expect, it, vi } from "vitest"

import { createResolvedInstanceGetter } from "../../src/worker/auth/initialized-instance-cache"

interface Deferred<Value> {
  promise: Promise<Value>
  reject: (reason?: unknown) => void
  resolve: (value: Value | PromiseLike<Value>) => void
}

interface TestInstance {
  $context: Promise<void>
  id: string
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: Deferred<Value>["resolve"]
  let reject!: Deferred<Value>["reject"]
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, reject, resolve }
}

describe("resolved instance cache", () => {
  it("does not publish a pending instance and returns the resolved concurrent winner", async () => {
    const environment = {}
    const firstContext = deferred<void>()
    const first: TestInstance = { $context: firstContext.promise, id: "first" }
    const second: TestInstance = {
      $context: Promise.resolve(),
      id: "second",
    }
    const instantiate = vi
      .fn<(environment: object) => TestInstance>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const getInstance = createResolvedInstanceGetter(instantiate)

    const firstCall = getInstance(environment)
    const secondCall = getInstance(environment)

    await expect(secondCall).resolves.toBe(second)
    expect(instantiate).toHaveBeenCalledTimes(2)

    firstContext.resolve()
    await expect(firstCall).resolves.toBe(second)
    await expect(getInstance(environment)).resolves.toBe(second)
    expect(instantiate).toHaveBeenCalledTimes(2)
  })

  it("does not cache a failed initialization", async () => {
    const environment = {}
    const failure = new Error("synthetic initialization failure")
    const failed: TestInstance = {
      $context: Promise.reject(failure),
      id: "failed",
    }
    const recovered: TestInstance = {
      $context: Promise.resolve(),
      id: "recovered",
    }
    const instantiate = vi
      .fn<(environment: object) => TestInstance>()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(recovered)
    const getInstance = createResolvedInstanceGetter(instantiate)

    await expect(getInstance(environment)).rejects.toBe(failure)
    await expect(getInstance(environment)).resolves.toBe(recovered)
    await expect(getInstance(environment)).resolves.toBe(recovered)
    expect(instantiate).toHaveBeenCalledTimes(2)
  })
})
