import { errorMessage } from "@lunar-spice/utils/error-message";
import { useRef, useState } from "react";

/**
 * Runs a dialog action one at a time: a second submission while it is pending does
 * nothing. A failure stays in `error` so the user can retry; `fallback` describes errors
 * without a message.
 */
export function useAsyncAction(fallback: string) {
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    if (pending.current) {
      return;
    }

    pending.current = true;
    setIsPending(true);
    setError(null);

    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause, fallback));
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  }

  return { run, isPending, error };
}
