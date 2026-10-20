/**
 * GPU VU meters. Samples come from a ring buffer and are written to the DOM in
 * requestAnimationFrame — 1 Hz telemetry never re-renders React. NVML reports no
 * shared-memory figure, so VRAM at >= 92 % of the total is the amber state (doc 05 A11).
 */
import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { gpuSchema } from '@/api/schemas';
import { Meter } from '@/components/Meter';
import { useAnimationFrame } from '@/components/motionPrefs';
import type { GpuSample, LiveBuffers } from '@/live/useJobEvents';

const NEAR_FULL = 0.92;

export function isMemoryWarning(sample: GpuSample): boolean {
  return sample.memTotalMb > 0 && sample.memUsedMb / sample.memTotalMb >= NEAR_FULL;
}

interface MeterRefs {
  meter: HTMLDivElement | null;
  fill: HTMLSpanElement | null;
  value: HTMLSpanElement | null;
}

function writeMeter(refs: MeterRefs, fraction: number, text: string, warn?: boolean): void {
  const f = Math.min(1, Math.max(0, fraction));
  if (refs.fill) refs.fill.style.transform = `scaleX(${f})`;
  if (refs.value) refs.value.textContent = text;
  if (refs.meter) {
    refs.meter.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    refs.meter.setAttribute('aria-valuetext', text);
    if (warn !== undefined) refs.meter.closest('.meter')?.setAttribute('data-warn', warn ? 'true' : 'false');
  }
}

interface GpuPanelProps {
  buffers: LiveBuffers;
}

export function GpuPanel({ buffers }: GpuPanelProps) {
  const gpu = useQuery({ queryKey: ['system', 'gpu', 'static'], queryFn: () => api('/system/gpu', gpuSchema), staleTime: Infinity, retry: false });
  const util = useRef<MeterRefs>({ meter: null, fill: null, value: null });
  const vram = useRef<MeterRefs>({ meter: null, fill: null, value: null });
  const factsRef = useRef<HTMLParagraphElement>(null);
  const version = useRef(-1);

  useAnimationFrame(() => {
    if (buffers.gpu.version === version.current) return;
    version.current = buffers.gpu.version;
    const s = buffers.gpu.latest();
    if (!s) return;
    if (s.util === null) writeMeter(util.current, 0, 'n/a');
    else writeMeter(util.current, s.util / 100, `${Math.round(s.util)}%`);
    const warn = isMemoryWarning(s);
    const total = s.memTotalMb > 0 ? s.memTotalMb : 1;
    writeMeter(vram.current, s.memUsedMb / total, `${(s.memUsedMb / 1024).toFixed(1)} / ${(s.memTotalMb / 1024).toFixed(1)} GB${warn ? ' · nearly full' : ''}`, warn);
    if (factsRef.current) {
      const parts = [
        s.tempC !== null ? `${Math.round(s.tempC)}°C` : null,
        s.clockMhz !== null ? `${Math.round(s.clockMhz).toLocaleString()} MHz` : null,
        s.powerW !== null ? `${Math.round(s.powerW)} W` : null,
      ].filter(Boolean);
      factsRef.current.textContent = parts.join(' · ');
    }
  });

  return (
    <section className="run-panel gpu-panel" aria-labelledby="gpu-title">
      <header className="panel-head">
        <h2 id="gpu-title" className="eyebrow">GPU</h2>
        <span className="gpu-name">{gpu.data?.name ?? 'graphics card'}</span>
      </header>
      <Meter
        label="util"
        value={0}
        text="—"
        meterRef={(el) => { util.current.meter = el; }}
        fillRef={(el) => { util.current.fill = el; }}
        valueRef={(el) => { util.current.value = el; }}
      />
      <Meter
        label="VRAM"
        value={0}
        text="—"
        meterRef={(el) => { vram.current.meter = el; }}
        fillRef={(el) => { vram.current.fill = el; }}
        valueRef={(el) => { vram.current.value = el; }}
      />
      <p className="gpu-facts num" ref={factsRef}>no samples yet</p>
    </section>
  );
}
