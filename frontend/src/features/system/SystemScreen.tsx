/** `/system` — GPU, prerequisite checks (doctor) and benchmark results. */
import { useBenchmarks, useDoctor, useGpu } from '@/api/hooks';
import type { BenchmarkRow, DoctorCheck, Gpu } from '@/api/schemas';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { formatDate } from '@/features/shared/format';
import '@/features/shared/library.css';
import './system.css';

/** NVML reports no shared-memory figure; VRAM this full is the warning state. */
const NEAR_FULL = 0.92;

interface MeterProps {
  label: string;
  used: number;
  total: number;
  text: string;
  tone?: 'warn' | 'fail' | undefined;
}

function Meter({ label, used, total, text, tone }: MeterProps) {
  const fraction = total > 0 ? Math.min(1, used / total) : 0;
  return (
    <div className="sys-meter" data-tone={tone}>
      <div className="sys-meter-head"><span>{label}</span><span className="num">{text}</span></div>
      <div className="sys-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used} aria-valuetext={text}>
        <span style={{ transform: `scaleX(${fraction})` }} />
      </div>
    </div>
  );
}

function GpuPanel({ gpu }: { gpu: Gpu }) {
  if (!gpu.available) {
    return (
      <div className="sys-gpu">
        <p className="field-error">No NVIDIA GPU is visible to the server. Check the driver (nvidia-smi) and restart the app.</p>
      </div>
    );
  }
  const used = gpu.mem_used_mb ?? 0;
  const total = gpu.mem_total_mb ?? 0;
  const isNearFull = total > 0 && used / total >= NEAR_FULL;
  return (
    <div className="sys-gpu">
      <p className="sys-gpu-name">{gpu.name ?? 'NVIDIA GPU'}</p>
      <Meter
        label="VRAM" used={used} total={total}
        text={total > 0 ? `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GB` : '—'}
        tone={isNearFull ? 'warn' : undefined}
      />
      {isNearFull ? (
        <p className="field-error">VRAM is nearly full: close other GPU programs, or training may spill into shared memory and slow down about 10×.</p>
      ) : null}
      <dl className="sys-gpu-facts">
        <div><dt>Driver</dt><dd className="num">{gpu.driver ?? '—'}</dd></div>
        <div><dt>Temperature</dt><dd className="num">{gpu.temp_c !== null && gpu.temp_c !== undefined ? `${gpu.temp_c} °C` : '—'}</dd></div>
        <div><dt>Load</dt><dd className="num">{gpu.util !== null && gpu.util !== undefined ? `${gpu.util}%` : '—'}</dd></div>
      </dl>
    </div>
  );
}

function DoctorList({ checks }: { checks: DoctorCheck[] }) {
  return (
    <ul className="doctor-list">
      {checks.map((check) => (
        <li key={check.id} className="doctor-row" data-status={check.ok ? 'ok' : 'fail'}>
          <span className="doctor-icon" aria-hidden="true">{check.ok ? '✓' : '✕'}</span>
          <div className="doctor-text">
            <span className="doctor-label">{check.label}</span>
            {check.detail ? <span className="muted doctor-detail" title={check.detail}>{check.detail}</span> : null}
            {!check.ok && check.hint ? <span className="doctor-hint">{check.hint}</span> : null}
          </div>
          <span className="chip" data-tone={check.ok ? 'ok' : 'fail'}>{check.ok ? 'ok' : 'fail'}</span>
        </li>
      ))}
    </ul>
  );
}

function BenchmarkTable({ rows }: { rows: BenchmarkRow[] }) {
  return (
    <div className="table-wrap">
      <table className="data sys-bench">
        <caption className="visually-hidden">Benchmark results</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th><th scope="col" className="num">Time</th><th scope="col" className="num">Audio</th>
            <th scope="col" className="num">Real-time factor</th><th scope="col" className="num">Peak VRAM</th><th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={`${b.stage}:${b.label}`}>
              <th scope="row" className="bench-stage">
                <span className="bench-stage-name">{b.stage}</span>
                {b.label && b.label !== b.stage ? <span className="bench-stage-label">{b.label}</span> : null}
              </th>
              <td className="num">{b.seconds.toFixed(1)} s</td>
              <td className="num">{b.audio_seconds !== null && b.audio_seconds !== undefined ? `${b.audio_seconds.toFixed(0)} s` : '—'}</td>
              <td className="num">{b.rtf !== null && b.rtf !== undefined ? `${b.rtf.toFixed(2)}×` : '—'}</td>
              <td className="num">{b.peak_vram_mb !== null && b.peak_vram_mb !== undefined ? `${(b.peak_vram_mb / 1024).toFixed(2)} GB` : '—'}</td>
              <td className="muted">{b.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SystemScreen() {
  const gpu = useGpu();
  const doctor = useDoctor();
  const benchmarks = useBenchmarks();
  const bench = benchmarks.data?.rows ?? [];
  const problems = doctor.data?.checks.filter((c) => !c.ok).length ?? 0;

  return (
    <section className="page" aria-labelledby="system-title">
      <header className="page-head">
        <div>
          <span className="eyebrow">This computer</span>
          <h1 id="system-title">System</h1>
        </div>
      </header>
      <div className="system-split">
        <section className="section" aria-labelledby="gpu-title">
          <div className="section-head"><h2 id="gpu-title">GPU</h2></div>
          {gpu.isPending ? <Loading label="Reading the GPU…" /> : null}
          {gpu.error ? <ErrorNote error={gpu.error} onRetry={() => void gpu.refetch()} /> : null}
          {gpu.data ? <GpuPanel gpu={gpu.data} /> : null}
        </section>
        <section className="section" aria-labelledby="doctor-title">
          <div className="section-head">
            <h2 id="doctor-title">Checks</h2>
            {doctor.data ? <span className="muted">{problems === 0 ? '✓ all good' : `${problems} need attention`}</span> : null}
          </div>
          {doctor.isPending ? <Loading label="Running checks…" /> : null}
          {doctor.error ? <ErrorNote error={doctor.error} onRetry={() => void doctor.refetch()} /> : null}
          {doctor.data ? <DoctorList checks={doctor.data.checks} /> : null}
        </section>
      </div>
      <section className="section" aria-labelledby="bench-title">
        <div className="section-head">
          <h2 id="bench-title">Benchmarks</h2>
          <span className="muted">
            measured on this GPU{benchmarks.data?.measured_at ? ` on ${formatDate(benchmarks.data.measured_at)}` : ''}; used for time estimates
          </span>
        </div>
        {benchmarks.isPending ? <Loading label="Loading benchmarks…" /> : null}
        {benchmarks.error ? <ErrorNote error={benchmarks.error} onRetry={() => void benchmarks.refetch()} /> : null}
        {benchmarks.isSuccess && bench.length === 0 ? <Empty title="No benchmarks yet" /> : null}
        {bench.length > 0 ? <BenchmarkTable rows={bench} /> : null}
      </section>
    </section>
  );
}
