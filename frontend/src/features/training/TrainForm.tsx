/** "Start training": epochs + batch size; advanced choices collapsed and sent only when set. */
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ApiError } from '@/api/client';
import { useTrain, type TrainOptions } from '@/api/hooks';
import { ErrorNote } from '@/components/Status';
import { Note } from '@/features/shared/Note';
import { MIN_MINUTES, WARN_MINUTES, formatMinutes } from '@/features/shared/format';

interface TrainFormProps {
  singerId: string;
  usableMinutes: number | null;
}

const SAMPLE_RATES = [32000, 40000, 48000] as const;
const VOCODERS = ['HiFi-GAN', 'MRF HiFi-GAN', 'RefineGAN'] as const;
const LIMITS = { epochs: [1, 1000], batch: [1, 32], saveEvery: [1, 100] } as const;

function intIn(text: string, [min, max]: readonly [number, number]): number | null {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

interface Draft {
  epochs: string;
  batch: string;
  saveEvery: string;
  sampleRate: string;
  vocoder: string;
}

/** Validated request body, or the first problem in words. Empty advanced fields use server defaults. */
function toBody(d: Draft): { body: TrainOptions } | { problem: string } {
  const epochs = intIn(d.epochs, LIMITS.epochs);
  if (epochs === null) return { problem: 'Epochs must be a whole number from 1 to 1000.' };
  const batch = intIn(d.batch, LIMITS.batch);
  if (batch === null) return { problem: 'Batch size must be a whole number from 1 to 32.' };
  const body: TrainOptions = { epochs, batch_size: batch };
  if (d.saveEvery.trim() !== '') {
    const saveEvery = intIn(d.saveEvery, LIMITS.saveEvery);
    if (saveEvery === null) return { problem: 'Save every must be a whole number of epochs from 1 to 100.' };
    body.save_every = saveEvery;
  }
  if (d.sampleRate) body.sample_rate = Number(d.sampleRate);
  if (d.vocoder) body.vocoder = d.vocoder;
  return { body };
}

export function TrainForm({ singerId, usableMinutes }: TrainFormProps) {
  const [draft, setDraft] = useState<Draft>({ epochs: '100', batch: '4', saveEvery: '', sampleRate: '', vocoder: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const train = useTrain(singerId);
  const navigate = useNavigate();
  const ids = { epochs: useId(), batch: useId(), save: useId(), rate: useId(), voc: useId(), err: useId() };
  const minutes = usableMinutes ?? 0;
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = toBody(draft);
    if ('problem' in result) {
      setProblem(result.problem);
      return;
    }
    setProblem(null);
    train.mutate(result.body, {
      onSuccess: (started) => void navigate({ to: '/jobs/$jobId', params: { jobId: started.job.id } }),
    });
  };

  const code = train.error instanceof ApiError ? train.error.code : null;

  return (
    <form className="train-form" onSubmit={onSubmit} noValidate aria-describedby={problem ? ids.err : undefined}>
      {usableMinutes !== null && minutes < WARN_MINUTES ? (
        <Note tone={minutes < MIN_MINUTES ? 'fail' : 'warn'}>
          Only <span className="num">{formatMinutes(minutes)}</span> minutes of usable singing.
          {minutes < MIN_MINUTES ? ' Training needs at least 5.' : ' The voice may sound thin; 30 minutes is the target.'}
        </Note>
      ) : null}
      <div className="train-fields">
        <label className="field" htmlFor={ids.epochs}>
          <span>Epochs</span>
          <input id={ids.epochs} className="input num" inputMode="numeric" value={draft.epochs} onChange={(e) => set({ epochs: e.target.value })} />
        </label>
        <label className="field" htmlFor={ids.batch}>
          <span>Batch size</span>
          <input id={ids.batch} className="input num" inputMode="numeric" value={draft.batch} onChange={(e) => set({ batch: e.target.value })} />
        </label>
      </div>
      <p className="muted train-help">
        Checkpoints are saved regularly and scored against the real voice; the best one is recommended,
        so you do not have to pick the epoch count perfectly. Batch 4 fits a 6 GB GPU. The dataset must be
        prepared first (Songs tab): preparing and training are separate jobs.
      </p>
      <details className="advanced">
        <summary>Advanced</summary>
        <div className="train-fields">
          <label className="field" htmlFor={ids.save}>
            <span>Save every (epochs)</span>
            <input id={ids.save} className="input num" inputMode="numeric" placeholder="default" value={draft.saveEvery}
              onChange={(e) => set({ saveEvery: e.target.value })} />
          </label>
          <label className="field" htmlFor={ids.rate}>
            <span>Sample rate</span>
            <select id={ids.rate} className="select" value={draft.sampleRate} onChange={(e) => set({ sampleRate: e.target.value })}>
              <option value="">Default</option>
              {SAMPLE_RATES.map((v) => <option key={v} value={v}>{v / 1000} kHz</option>)}
            </select>
          </label>
          <label className="field" htmlFor={ids.voc}>
            <span>Vocoder</span>
            <select id={ids.voc} className="select" value={draft.vocoder} onChange={(e) => set({ vocoder: e.target.value })}>
              <option value="">Default</option>
              {VOCODERS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        </div>
      </details>
      {problem ? <p id={ids.err} className="field-error" role="alert">{problem}</p> : null}
      {train.error ? <ErrorNote error={train.error} /> : null}
      {code === 'dataset_too_small' || code === 'dataset_not_prepared' ? (
        <p className="train-next">
          {code === 'dataset_too_small'
            ? <Link to="/singers/$id/songs" params={{ id: singerId }}>Add more songs</Link>
            : <Link to="/singers/$id/songs" params={{ id: singerId }}>Prepare the dataset</Link>}
          {' · '}
          <Link to="/singers/$id/dataset" params={{ id: singerId }}>Review rejected clips</Link>
        </p>
      ) : null}
      <div>
        <button type="submit" className="btn btn-primary" disabled={train.isPending}>
          {train.isPending ? 'Queueing…' : 'Start training'}
        </button>
      </div>
    </form>
  );
}
