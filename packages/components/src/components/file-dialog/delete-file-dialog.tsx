import { ActionDialog } from "@lunar-spice/components/action-dialog/action-dialog";
import { useAsyncAction } from "@lunar-spice/components/hooks/use-async-action";

/** Saved files are deleted; drafts, never saved, are discarded. */
export type DeleteVerb = "Delete" | "Discard";

/**
 * Asks before deleting a file, or discarding a draft, with `verb` naming which. Failures
 * stay in the dialog so the user can retry.
 */
export function DeleteFileDialog({
  name,
  verb,
  onClose,
  onDelete,
}: {
  name: string;
  verb: DeleteVerb;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const { run, isPending, error } = useAsyncAction(
    `Unable to ${verb.toLowerCase()} “${name}”.`,
  );

  return (
    <ActionDialog
      onClose={onClose}
      title={`${verb} “${name}”?`}
      description="This cannot be undone."
      confirmLabel={verb}
      confirmVariant="destructive"
      pending={isPending}
      error={error}
      onConfirm={() =>
        void run(async () => {
          await onDelete();
          onClose();
        })
      }
    />
  );
}
