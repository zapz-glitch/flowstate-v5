// The Worker runs with the `nodejs_compat` flag, which provides
// node:async_hooks at runtime. The project compiles against the Workers
// types only, so declare the one class the call log uses.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R
    getStore(): T | undefined
  }
}
