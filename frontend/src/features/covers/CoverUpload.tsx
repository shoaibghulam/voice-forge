/** Upload one song (tus, purpose cover or analysis). Reports the upload id when done. */
import { useEffect, useId, useRef, useState } from 'react';
import type * as tus from 'tus-js-client';
import type { ErrorText } from '@/api/errors';
import { ACCEPTED_AUDIO, AUDIO_EXTENSIONS, startTusUpload, uploadIdFrom } from '@/features/shared/tus';

export interface CoverUploadState {
  uploadId: string | null;
  filename: string | null;
}

interface CoverUploadProps {
  onChange: (state: CoverUploadState) => void;
  purpose?: 'cover' | 'analysis';
  hint?: string;
}

type Phase = 'idle' | 'uploading' | 'done' | 'error';

export function CoverUpload({ onChange, purpose = 'cover', hint = 'The backing is kept; only the lead vocal is replaced.' }: CoverUploadProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [fraction, setFraction] = useState(0);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<ErrorText | null>(null);
  const upload = useRef<tus.Upload | null>(null);
  const onChangeRef = useRef(onChange);
  const inputId = useId();

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => () => { void upload.current?.abort().catch(() => undefined); }, []);

  const start = (file: File) => {
    void upload.current?.abort().catch(() => undefined);
    setName(file.name);
    setError(null);
    setFraction(0);
    onChangeRef.current({ uploadId: null, filename: file.name });
    if (!AUDIO_EXTENSIONS.test(file.name)) {
      setPhase('error');
      setError({ title: `"${file.name}" is not a supported audio file.`, help: 'Use MP3, WAV, FLAC, M4A, OGG, OPUS or AAC.' });
      return;
    }
    setPhase('uploading');
    upload.current = startTusUpload(file, { purpose }, {
      onProgress: (sent, total) => setFraction(total > 0 ? sent / total : 0),
      onSuccess: (url) => {
        setPhase('done');
        setFraction(1);
        onChangeRef.current({ uploadId: uploadIdFrom(url), filename: file.name });
      },
      onError: (err) => { setPhase('error'); setError(err); },
    });
  };

  return (
    <div className="cover-upload">
      <input
        id={inputId} type="file" accept={ACCEPTED_AUDIO} className="visually-hidden"
        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) start(file); }}
      />
      <label htmlFor={inputId} className="cover-upload-label">
        <span className="btn">{name ? 'Choose a different song' : 'Choose the song'}</span>
        <span className="muted">{hint}</span>
      </label>
      {name ? (
        <div className="cover-upload-file">
          <div className="upload-row-head">
            <span className="upload-name">{name}</span>
            <span className="num upload-pct" data-tone={phase === 'done' ? 'ok' : phase === 'error' ? 'fail' : undefined}>
              {phase === 'done' ? '✓ uploaded' : phase === 'error' ? '✕ failed' : `${Math.round(fraction * 100)}%`}
            </span>
          </div>
          <div className="bar" data-tone={phase === 'done' ? 'ok' : phase === 'error' ? 'fail' : undefined}
            role="progressbar" aria-label={`Upload of ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
            <span style={{ transform: `scaleX(${fraction})` }} />
          </div>
          {error ? (
            <p className="upload-error" role="alert"><strong>{error.title}</strong>{error.help ? <span className="muted"> {error.help}</span> : null}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
