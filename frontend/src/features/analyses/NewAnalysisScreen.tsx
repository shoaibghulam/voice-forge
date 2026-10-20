/** `/analyses/new` — upload a song (tus, purpose analysis), pick the language, start. */
import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useCreateAnalysis } from '@/api/hooks';
import type { LanguageHint } from '@/api/schemas';
import { ErrorNote } from '@/components/Status';
import { CoverUpload, type CoverUploadState } from '@/features/covers/CoverUpload';
import '@/features/covers/covers.css';
import '@/features/shared/library.css';
import { LANGUAGE_OPTIONS } from './analysisModel';
import './analyses.css';

export function NewAnalysisScreen() {
  const [upload, setUpload] = useState<CoverUploadState>({ uploadId: null, filename: null });
  const [language, setLanguage] = useState<LanguageHint>('auto');
  const create = useCreateAnalysis();
  const navigate = useNavigate();
  const missing = upload.uploadId ? null : upload.filename ? 'wait for the upload to finish' : 'upload a song';

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!upload.uploadId) return;
    create.mutate(
      { upload_id: upload.uploadId, language },
      { onSuccess: (analysis) => void navigate({ to: '/analyses/$id', params: { id: analysis.id } }) },
    );
  };

  return (
    <section className="page" aria-labelledby="new-analysis-title">
      <header className="page-head">
        <div>
          <span className="eyebrow">Analyse</span>
          <h1 id="new-analysis-title">New analysis</h1>
        </div>
      </header>
      <form className="cover-form" onSubmit={onSubmit} noValidate>
        <ol className="cover-steps">
          <li className="cover-step">
            <h2 className="step-title"><span className="step-no num" aria-hidden="true">1</span> Song</h2>
            <CoverUpload purpose="analysis" hint="Up to 20 minutes. Nothing is changed: the song is only listened to." onChange={setUpload} />
          </li>
          <li className="cover-step">
            <h2 className="step-title"><span className="step-no num" aria-hidden="true">2</span> Language of the lyrics</h2>
            <fieldset className="control">
              <legend className="visually-hidden">Language of the lyrics</legend>
              <div className="toggle-group an-languages">
                {LANGUAGE_OPTIONS.map((option) => (
                  <button key={option.value} type="button" aria-pressed={language === option.value} onClick={() => setLanguage(option.value)}>
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="muted control-help">
                {language === 'bal'
                  ? 'Balochi: the speech model has no Balochi, so the words come out as a rough draft in Urdu letters for you to correct.'
                  : 'Auto-detect chooses between Urdu, Persian and English. For Balochi songs pick Balochi (a rough draft you can correct).'}
              </p>
            </fieldset>
          </li>
        </ol>
        {create.error ? <ErrorNote error={create.error} /> : null}
        <div className="cover-submit">
          <button type="submit" className="btn btn-primary" disabled={missing !== null || create.isPending} aria-describedby="analysis-missing">
            {create.isPending ? 'Queueing…' : 'Analyse the song'}
          </button>
          <p id="analysis-missing" className="muted" aria-live="polite">
            {missing ? `To continue: ${missing}.` : 'Ready. A 4-minute song takes about 3 minutes.'}
          </p>
        </div>
      </form>
    </section>
  );
}
