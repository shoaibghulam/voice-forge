/** Import a voice zip into a singer (multipart field `file` → POST /singers/{id}/voices/import). */
import { useId, useRef, useState, type ChangeEvent } from 'react';
import { useImportVoice } from '@/api/hooks';
import { ErrorNote } from '@/components/Status';

interface ImportVoiceButtonProps {
  singerId: string;
}

export function ImportVoiceButton({ singerId }: ImportVoiceButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const importVoice = useImportVoice(singerId);
  const [imported, setImported] = useState<string | null>(null);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImported(null);
    importVoice.mutate(file, { onSuccess: () => setImported(file.name) });
  };

  return (
    <div className="import-voice">
      <input
        ref={input} id={inputId} type="file" accept=".zip,application/zip" className="visually-hidden"
        tabIndex={-1} aria-hidden="true" onChange={onChange}
      />
      <button type="button" className="btn" onClick={() => input.current?.click()} disabled={importVoice.isPending}>
        {importVoice.isPending ? 'Importing…' : 'Import voice zip'}
      </button>
      <span role="status" className="import-voice-status">
        {imported ? <span className="chip" data-tone="ok">✓ imported {imported}</span> : null}
      </span>
      {importVoice.error ? <ErrorNote error={importVoice.error} onRetry={() => input.current?.click()} /> : null}
    </div>
  );
}
