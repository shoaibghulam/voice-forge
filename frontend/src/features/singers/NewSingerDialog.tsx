/** "New singer": name + consent record → POST /singers (docs/01 "Ethics and rights"). */
import * as Dialog from '@radix-ui/react-dialog';
import { useId, useState, type FormEvent } from 'react';
import { useCreateSinger } from '@/api/hooks';
import { ErrorNote } from '@/components/Status';
import '@/features/shared/library.css';

interface FormErrors {
  name?: string;
  consent?: string;
}

function validate(name: string, living: boolean, estate: boolean): FormErrors {
  const errors: FormErrors = {};
  if (!name.trim()) errors.name = 'Name is required.';
  else if (name.trim().length > 80) errors.name = 'Keep the name under 80 characters.';
  if (!living && !estate) errors.consent = 'Record the singer’s consent or the family’s permission before adding them.';
  return errors;
}

export function NewSingerDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [living, setLiving] = useState(false);
  const [estate, setEstate] = useState(false);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const create = useCreateSinger();
  const ids = { name: useId(), nameErr: useId(), consentErr: useId(), notes: useId() };

  const reset = () => {
    setName(''); setLiving(false); setEstate(false); setNotes(''); setErrors({});
    create.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(name, living, estate);
    setErrors(found);
    if (found.name || found.consent) return;
    create.mutate(
      { name: name.trim(), consent: { living_consent: living, estate_permission: estate, notes: notes.trim() || null } },
      { onSuccess: () => { setOpen(false); reset(); } },
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
      <Dialog.Trigger asChild>
        <button type="button" className="btn btn-primary">New singer</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title>New singer</Dialog.Title>
          <Dialog.Description className="muted">
            A voice belongs to a person. Record whose permission you have before training on it.
          </Dialog.Description>
          <form className="dialog-form" onSubmit={onSubmit} noValidate>
            <div className="field">
              <label className="field-label" htmlFor={ids.name}>Name</label>
              <input
                id={ids.name} className="input" value={name} autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? ids.nameErr : undefined}
              />
              {errors.name ? <p id={ids.nameErr} className="field-error">{errors.name}</p> : null}
            </div>
            <fieldset className="consent-set" aria-describedby={errors.consent ? ids.consentErr : undefined}>
              <legend className="eyebrow">Consent</legend>
              <label className="check">
                <input type="checkbox" checked={living} onChange={(e) => setLiving(e.target.checked)} />
                <span>The singer is living and gave written consent</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={estate} onChange={(e) => setEstate(e.target.checked)} />
                <span>The family or estate gave permission</span>
              </label>
              {errors.consent ? <span id={ids.consentErr} className="field-error">{errors.consent}</span> : null}
            </fieldset>
            <label className="field" htmlFor={ids.notes}>
              <span>Notes (optional)</span>
              <textarea id={ids.notes} className="input textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            {create.error ? <ErrorNote error={create.error} /> : null}
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-quiet">Cancel</button>
              </Dialog.Close>
              <button type="submit" className="btn btn-primary" disabled={create.isPending}>
                {create.isPending ? 'Adding…' : 'Add singer'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
