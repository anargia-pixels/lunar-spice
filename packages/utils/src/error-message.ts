/** The message of `cause` when it is an Error, else `fallback`. */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
