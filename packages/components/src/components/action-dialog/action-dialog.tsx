import { Alert, AlertDescription } from "@lunar-spice/components/ui/alert";
import { Button } from "@lunar-spice/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lunar-spice/components/ui/dialog";
import type { ReactNode } from "react";

/**
 * An action form, open while it is mounted; its caller owns pending state, errors, and
 * closing on success. Escape, the close button and Cancel call `onClose` unless the
 * action is pending.
 */
export function ActionDialog({
  onClose,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
  error,
  children,
  confirmVariant = "default",
  disabled = false,
}: {
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
  children?: ReactNode;
  confirmVariant?: "default" | "destructive";
  disabled?: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose();
        }
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();

            if (!pending && !disabled) {
              onConfirm();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" disabled={pending} />}
            >
              Cancel
            </DialogClose>
            <Button
              type="submit"
              variant={confirmVariant}
              disabled={pending || disabled}
              aria-busy={pending}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
