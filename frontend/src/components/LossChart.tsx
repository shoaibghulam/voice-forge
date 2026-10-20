/**
 * Training losses (docs/07 "Loss chart"): uPlot fed from a ring buffer in a ref, pushed
 * with setData inside requestAnimationFrame — never through React state. Series toggles,
 * log scale, checkpoint ticks, a live tail marker, a text summary and a data table.
 */
import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { SeriesRing } from '@/live/ringBuffer';
import type { LossKey } from '@/live/useJobEvents';
import { useAnimationFrame } from './motionPrefs';
import { LossTable, lossSummary, SERIES } from './lossSummary';
import './loss-chart.css';

interface LossChartProps {
  buffer: SeriesRing<LossKey>;
  checkpointSteps: readonly number[];
  stepsPerEpoch: number;
  isLive: boolean;
  height?: number;
}

/** uPlot draws `null` as a gap; a loss key missing from a sample is stored as NaN. */
function plotData(buffer: SeriesRing<LossKey>): uPlot.AlignedData {
  const [xs = [], ...series] = buffer.toColumns(SERIES_KEYS);
  return [xs, ...series.map((col) => col.map((v) => (Number.isFinite(v) ? v : null)))] as uPlot.AlignedData;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

interface DrawState {
  checkpoints: readonly number[];
  isLive: boolean;
}

function makeOptions(width: number, height: number, isLog: boolean, visible: Record<LossKey, boolean>, draw: { current: DrawState }): uPlot.Options {
  const ink = cssVar('--color-muted');
  const grid = cssVar('--color-line');
  const signal = cssVar('--color-signal');
  const font = `11px ${cssVar('--font-mono') || 'monospace'}`;
  const axis = { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, font };
  return {
    width,
    height,
    legend: { show: false },
    cursor: { y: false, points: { size: 6 } },
    scales: { x: { time: false }, y: { distr: isLog ? 3 : 1 } },
    axes: [{ ...axis, label: 'step', labelFont: font, labelSize: 18 }, { ...axis, size: 48 }],
    series: [
      { label: 'step' },
      ...SERIES.map((s) => ({
        label: s.label,
        stroke: cssVar(s.color),
        width: s.key === 'mel' ? 2 : 1.25,
        show: visible[s.key],
        points: { show: false },
      })),
    ],
    hooks: {
      draw: [
        (u: uPlot) => {
          const ctx = u.ctx;
          const { top, height: h } = u.bbox;
          ctx.save();
          ctx.strokeStyle = cssVar('--color-accent');
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          for (const step of draw.current.checkpoints) {
            const x = Math.round(u.valToPos(step, 'x', true));
            if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + h);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          const xs = u.data[0];
          const mel = u.data[1];
          const n = xs?.length ?? 0;
          if (draw.current.isLive && n > 0 && xs && mel) {
            const lastY = mel[n - 1];
            const lastX = xs[n - 1];
            if (typeof lastY === 'number' && typeof lastX === 'number') {
              const px = u.valToPos(lastX, 'x', true);
              const py = u.valToPos(lastY, 'y', true);
              ctx.fillStyle = signal;
              ctx.beginPath();
              ctx.arc(px, py, 4 * devicePixelRatio, 0, Math.PI * 2);
              ctx.fill();
              ctx.font = `${10 * devicePixelRatio}px ${cssVar('--font-mono') || 'monospace'}`;
              ctx.fillText('live', px - 26 * devicePixelRatio, py - 8 * devicePixelRatio);
            }
          }
          ctx.restore();
        },
      ],
    },
  };
}

const SERIES_KEYS: readonly LossKey[] = SERIES.map((s) => s.key);

const INITIAL_VISIBLE: Record<LossKey, boolean> = { mel: true, kl: true, fm: false, adv: false, g_total: false, d_adv: false };

export function LossChart({ buffer, checkpointSteps, stepsPerEpoch, isLive, height = 220 }: LossChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const versionRef = useRef(-1);
  const drawRef = useRef<DrawState>({ checkpoints: checkpointSteps, isLive });
  drawRef.current = { checkpoints: checkpointSteps, isLive };
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const [isLog, setIsLog] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [summary, setSummary] = useState('No loss values yet.');
  const [themeTick, setThemeTick] = useState(0);

  // follow theme switches (colours are read from tokens at creation)
  useEffect(() => {
    const bump = () => setThemeTick((t) => t + 1);
    window.addEventListener('mt:themechange', bump);
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    media?.addEventListener('change', bump);
    return () => {
      window.removeEventListener('mt:themechange', bump);
      media?.removeEventListener('change', bump);
    };
  }, []);

  // (re)create the plot when scale or theme changes
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let plot: uPlot | null = null;
    try {
      const width = Math.max(240, host.clientWidth || 600);
      plot = new uPlot(makeOptions(width, height, isLog, visible, drawRef), plotData(buffer), host);
    } catch {
      plot = null; // canvas unavailable (tests / very old browsers): table + summary still work
    }
    plotRef.current = plot;
    versionRef.current = buffer.version;
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => plot?.setSize({ width: Math.max(240, host.clientWidth), height }))
      : null;
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      plot?.destroy();
      plotRef.current = null;
    };
    // visibility is applied with setSeries below, not by recreating the plot
  }, [buffer, height, isLog, themeTick]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    SERIES.forEach((s, i) => plot.setSeries(i + 1, { show: visible[s.key] }));
  }, [visible]);

  useAnimationFrame(() => {
    if (buffer.version === versionRef.current) return;
    versionRef.current = buffer.version;
    plotRef.current?.setData(plotData(buffer));
  });

  // text summary at a calm 0.5 Hz
  useEffect(() => {
    const update = () => setSummary(lossSummary(buffer, stepsPerEpoch));
    update();
    const id = setInterval(update, 2000);
    return () => clearInterval(id);
  }, [buffer, stepsPerEpoch]);

  return (
    <figure className="loss-chart">
      <figcaption className="loss-head">
        <span className="eyebrow">Loss</span>
        <div className="toggle-group" role="group" aria-label="Loss series">
          {SERIES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={visible[s.key]}
              onClick={() => setVisible((v) => ({ ...v, [s.key]: !v[s.key] }))}
            >
              <span className="loss-swatch" style={{ background: `var(${s.color})` }} aria-hidden="true" />
              {s.label}
            </button>
          ))}
        </div>
        <div className="toggle-group" role="group" aria-label="Chart options">
          <button type="button" aria-pressed={isLog} onClick={() => setIsLog((x) => !x)}>log</button>
          <button type="button" aria-pressed={showTable} onClick={() => setShowTable((x) => !x)}>table</button>
        </div>
      </figcaption>
      <div ref={hostRef} className="loss-plot" style={{ minHeight: height }} aria-hidden="true" />
      <p className="loss-summary" aria-live="off">{summary}</p>
      {showTable ? <LossTable buffer={buffer} /> : null}
    </figure>
  );
}
