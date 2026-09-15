/**
 * Test-environment helpers.
 *
 * `@types/node` types `process.env.NODE_ENV` as read-only, which is correct for product
 * code — nothing at runtime should reassign it. Test bootstraps legitimately need to, so
 * the narrow escape hatch lives here rather than being repeated as a cast in each setup
 * file.
 */

const mutableEnv = process.env as Record<string, string | undefined>;

/** Sets a variable unconditionally. */
export function setEnv(key: string, value: string): void {
  mutableEnv[key] = value;
}

/** Sets a variable only when it is not already provided by the caller or CI. */
export function defaultEnv(key: string, value: string): void {
  if (mutableEnv[key] === undefined || mutableEnv[key] === '') {
    mutableEnv[key] = value;
  }
}
