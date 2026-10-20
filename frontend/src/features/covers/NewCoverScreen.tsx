/** `/covers/new` — consent, upload, voice, controls → POST /covers → the cover page. */
import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useCreateCover, type NewCover } from '@/api/hooks';
import type { CoverSettings } from '@/api/schemas';
import { ErrorNote } from '@/components/Status';
import { CoverControls, DEFAULT_SETTINGS } from './CoverControls';
import { CoverUpload, type CoverUploadState } from './CoverUpload';
import { EthicsNotice } from './EthicsNotice';
import { VoicePicker, type VoiceChoice } from './VoicePicker';
import '@/features/shared/library.css';
import './covers.css';

function missingSteps(ack: boolean, upload: CoverUploadState, voice: VoiceChoice): string[] {
  const missing: string[] = [];
  if (!ack) missing.push('acknowledge the permissions notice');
  if (!upload.uploadId) missing.push(upload.filename ? 'wait for the upload to finish' : 'upload a song');
  if (!voice.singerId) missing.push('choose a singer');
  return missing;
}

export function NewCoverScreen() {
  const [ack, setAck] = useState(false);
  const [upload, setUpload] = useState<CoverUploadState>({ uploadId: null, filename: null });
  const [voice, setVoice] = useState<VoiceChoice>({ singerId: '', checkpointId: null });
  const [settings, setSettings] = useState<CoverSettings>(DEFAULT_SETTINGS);
  const create = useCreateCover();
  const navigate = useNavigate();
  const missing = missingSteps(ack, upload, voice);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (missing.length > 0 || !upload.uploadId) return;
    const body: NewCover = {
      upload_id: upload.uploadId,
      singer_id: voice.singerId,
      settings,
      ...(voice.checkpointId !== null ? { checkpoint_id: voice.checkpointId } : {}),
    };
    create.mutate(body, { onSuccess: (cover) => void navigate({ to: '/covers/$id', params: { id: cover.id } }) });
  };

  return (
    <section className="page new-cover" aria-labelledby="new-cover-title">
      <header className="page-head">
        <div>
          <span className="eyebrow">Covers</span>
          <h1 id="new-cover-title">New cover</h1>
        </div>
      </header>
      <form className="cover-form" onSubmit={onSubmit} noValidate>
        <EthicsNotice acknowledged={ack} onChange={setAck} />
        <ol className="cover-steps">
          <li className="cover-step">
            <h2 className="step-title"><span className="step-no num" aria-hidden="true">1</span> Song</h2>
            <CoverUpload onChange={setUpload} />
          </li>
          <li className="cover-step">
            <h2 className="step-title"><span className="step-no num" aria-hidden="true">2</span> Voice</h2>
            <VoicePicker value={voice} onChange={setVoice} />
          </li>
          <li className="cover-step">
            <h2 className="step-title"><span className="step-no num" aria-hidden="true">3</span> Sound</h2>
            <CoverControls value={settings} onChange={setSettings} />
          </li>
        </ol>
        {create.error ? <ErrorNote error={create.error} /> : null}
        <div className="cover-submit">
          <button type="submit" className="btn btn-primary" disabled={missing.length > 0 || create.isPending} aria-describedby="cover-missing">
            {create.isPending ? 'Queueing…' : 'Make the cover'}
          </button>
          <p id="cover-missing" className="muted" aria-live="polite">
            {missing.length > 0 ? `To continue: ${missing.join(', ')}.` : 'Ready. Conversion takes about as long as the song.'}
          </p>
        </div>
      </form>
    </section>
  );
}
