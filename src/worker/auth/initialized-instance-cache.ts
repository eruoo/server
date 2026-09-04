interface ContextInitializable {
  $context: PromiseLike<unknown>
}

/**
 * 按环境对象(Workers 每次 isolate 启动的 env 实例)缓存已初始化的
 * Better Auth 实例。$context 是 Better Auth 内部异步初始化钩子;
 * 并发请求只会产生一次初始化,同 isolate 内后续请求复用。
 */
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
