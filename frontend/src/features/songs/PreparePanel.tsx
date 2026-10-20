/** "Prepare dataset": pick a cleaning preset → POST prepare → open the live run. */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { usePrepare } from '@/api/hooks';
import { PRESETS, type Preset } from '@/api/schemas';
import { ErrorNote } from '@/components/Status';

interface PreparePanelProps {
  singerId: string;
  songCount: number;
}

const PRESET_HELP: Record<Preset, string> = {
  cassette: 'Old tapes: stronger hiss and hum removal, gentle de-echo.',
  studio: 'Clean recordings: light cleaning, keeps the most detail.',
  live: 'Concerts: strong de-echo and crowd/bleed rejection.',
};

export function PreparePanel({ singerId, songCount }: PreparePanelProps) {
  const [preset, setPreset] = useState<Preset>('cassette');
  const prepare = usePrepare(singerId);
  const navigate = useNavigate();

  const start = () => {
    prepare.mutate(preset, {
      onSuccess: (job) => void navigate({ to: '/jobs/$jobId', params: { jobId: job.id } }),
    });
  };

  return (
    <section className="section" aria-labelledby="prepare-title">
      <div className="section-head">
        <h2 id="prepare-title">Prepare dataset</h2>
        <span className="muted">separate → clean → slice → check</span>
      </div>
      <div className="prepare-row">
        <div role="group" aria-label="Cleaning preset" className="toggle-group">
          {PRESETS.map((value) => (
            <button key={value} type="button" aria-pressed={preset === value} onClick={() => setPreset(value)}>
              {value}
            </button>
          ))}
        </div>
        <p className="muted prepare-help">{PRESET_HELP[preset]}</p>
        <button type="button" className="btn btn-primary" onClick={start} disabled={prepare.isPending || songCount === 0}>
          {prepare.isPending ? 'Queueing…' : 'Prepare dataset'}
        </button>
      </div>
      {songCount === 0 ? <p className="muted">Upload at least one song first.</p> : null}
      {prepare.error ? <ErrorNote error={prepare.error} /> : null}
    </section>
  );
}
