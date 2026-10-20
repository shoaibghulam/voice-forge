/** A Radix confirm dialog for destructive actions; shows the server error inline. */
import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { ErrorNote } from '@/components/Status';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: unknown;
}

export function ConfirmDialog({ open, onOpenChange, title, children, confirmLabel, onConfirm, pending = false, error }: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="muted">{children}</div>
          </Dialog.Description>
          {error ? <ErrorNote error={error} /> : null}
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-quiet">Keep it</button>
            </Dialog.Close>
            <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={pending}>
              {pending ? 'Working…' : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
