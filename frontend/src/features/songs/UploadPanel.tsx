/** Era picker + drop zone + per-file progress for song uploads (tus). */
import { useEffect, useId, useState, type DragEvent } from 'react';
import { ERAS, type Era } from '@/api/schemas';
import { ACCEPTED_AUDIO, findUnfinishedUploads, type UnfinishedUpload } from '@/features/shared/tus';
import { useSongUploads, type UploadItem } from './useSongUploads';

interface UploadPanelProps {
  singerId: string;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function UploadRow({ item, onStop, onDismiss }: { item: UploadItem; onStop: () => void; onDismiss: () => void }) {
  const fraction = item.size > 0 ? Math.min(1, item.sent / item.size) : item.status === 'done' ? 1 : 0;
  const tone = item.status === 'error' ? 'fail' : item.status === 'done' ? 'ok' : undefined;
  const statusText = item.status === 'uploading' ? `${Math.round(fraction * 100)}%`
    : item.status === 'done' ? '✓ uploaded' : item.status === 'stopped' ? 'stopped' : '✕ failed';
  return (
    <li className="upload-row" data-status={item.status}>
      <div className="upload-row-head">
        <span className="upload-name">{item.name}</span>
        <span className="chip">{item.era}</span>
        <span className="num muted upload-size">{mb(item.sent)} / {mb(item.size)} MB</span>
        <span className="num upload-pct" data-tone={tone}>{statusText}</span>
        {item.status === 'uploading' ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onStop} aria-label={`Stop uploading ${item.name}`}>Stop</button>
        ) : (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onDismiss} aria-label={`Dismiss ${item.name}`}>Dismiss</button>
        )}
      </div>
      <div
        className="bar" data-tone={tone} role="progressbar" aria-label={`Upload of ${item.name}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}
      >
        <span style={{ transform: `scaleX(${fraction})` }} />
      </div>
      {item.error ? (
        <p className="upload-error" role="alert">
          <strong>{item.error.title}</strong>
          {item.error.help ? <span className="muted"> {item.error.help}</span> : null}
        </p>
      ) : null}
    </li>
  );
}

export function UploadPanel({ singerId }: UploadPanelProps) {
  const [era, setEra] = useState<Era>('unknown');
  const [dragging, setDragging] = useState(false);
  const [unfinished, setUnfinished] = useState<UnfinishedUpload[]>([]);
  const { items, add, stop, dismiss } = useSongUploads(singerId);
  const ids = { era: useId(), input: useId(), hint: useId() };

  useEffect(() => {
    let alive = true;
    void findUnfinishedUploads((m) => m['purpose'] === 'dataset' && m['singer_id'] === singerId).then((found) => {
      if (alive) setUnfinished(found);
    });
    return () => { alive = false; };
  }, [singerId]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) add(files, era);
  };

  return (
    <section className="section" aria-labelledby="upload-title">
      <div className="section-head">
        <h2 id="upload-title">Add songs</h2>
        <label className="field era-pick" htmlFor={ids.era}>
          <span>Era of these recordings</span>
          <select id={ids.era} className="select" value={era} onChange={(e) => setEra(e.target.value as Era)}>
            {ERAS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
      <div
        className="drop-zone" data-dragging={dragging || undefined}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          id={ids.input} type="file" multiple accept={ACCEPTED_AUDIO} className="visually-hidden drop-input"
          aria-describedby={ids.hint}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length > 0) add(files, era);
          }}
        />
        <label htmlFor={ids.input} className="drop-label">
          <svg viewBox="0 0 48 16" width="48" height="16" aria-hidden="true" className="drop-icon">
            <line x1="2" y1="8" x2="46" y2="8" />
            <circle cx="6" cy="8" r="4" />
            <path d="M34 3l8 5-8 5" />
          </svg>
          <span className="drop-title">Drop songs here or <u>choose songs</u></span>
        </label>
        <p id={ids.hint} className="muted drop-hint">
          MP3, WAV, FLAC, M4A, OGG, OPUS or AAC · 20 s to 20 min · up to 1 GB each. Uploads resume if the page reloads.
        </p>
      </div>
      {unfinished.length > 0 ? (
        <p className="muted unfinished">
          Unfinished: {unfinished.map((u) => u.filename).join(', ')} — choose the same file again to continue where it stopped.
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul className="upload-list" aria-label="Uploads">
          {items.map((item) => (
            <UploadRow key={item.key} item={item} onStop={() => stop(item.key)} onDismiss={() => dismiss(item.key)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
