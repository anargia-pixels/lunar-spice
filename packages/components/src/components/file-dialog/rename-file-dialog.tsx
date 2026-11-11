import { ActionDialog } from "@lunar-spice/components/action-dialog/action-dialog";
import { useAsyncAction } from "@lunar-spice/components/hooks/use-async-action";
import { Input } from "@lunar-spice/components/ui/input";
import { Label } from "@lunar-spice/components/ui/label";
import { useId, useState } from "react";

/** Edits the name while keeping the extension, and reports failures without closing. */
export function RenameFileDialog({
  name,
  onClose,
  onRename,
}: {
  /** The current title, which the field starts with. */
  name: string;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(name);

  const { run, isPending, error } = useAsyncAction(
    "Unable to rename the file.",
  );

  const inputId = useId();

  return (
    <ActionDialog
      onClose={onClose}
      title="Rename file"
      description={`Choose a new name for “${name}”. The extension stays the same.`}
      confirmLabel="Rename"
      pending={isPending}
      error={error}
      disabled={!title.trim()}
      onConfirm={() =>
        void run(async () => {
          await onRename(title.trim());
          onClose();
        })
      }
    >
      <div className="grid gap-2">
        <Label htmlFor={inputId}>Name</Label>
        <Input
          id={inputId}
          value={title}
          disabled={isPending}
          onChange={(event) => setTitle(event.target.value)}
          onFocus={(event) => event.target.select()}
          required
        />
      </div>
    </ActionDialog>
  );
}
