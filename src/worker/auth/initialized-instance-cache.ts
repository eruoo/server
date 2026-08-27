interface ContextInitializable {
  $context: PromiseLike<unknown>
}

export function createResolvedInstanceGetter<
  Environment extends object,
  Instance extends ContextInitializable,
>(instantiate: (environment: Environment) => Instance) {
  const resolvedInstances = new WeakMap<Environment, Instance>()

  return async (environment: Environment): Promise<Instance> => {
    const cached = resolvedInstances.get(environment)
    if (cached) {
      return cached
    }

    const candidate = instantiate(environment)
    await candidate.$context

    const concurrentWinner = resolvedInstances.get(environment)
    if (concurrentWinner) {
      return concurrentWinner
    }

    resolvedInstances.set(environment, candidate)
    return candidate
  }
}
