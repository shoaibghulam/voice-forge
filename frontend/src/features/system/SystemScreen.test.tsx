import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderApp } from '@/test/renderApp';
import { server } from '@/test/server';

describe('SystemScreen', () => {
  it('shows the GPU, the failing doctor check with its hint, and benchmark rows', async () => {
    renderApp('/system');

    expect(await screen.findByText('NVIDIA GeForce RTX 4050 Laptop GPU')).toBeInTheDocument();
    expect(await screen.findByText('1 need attention')).toBeInTheDocument();
    const sysmem = screen.getByText('CUDA sysmem fallback').closest('li');
    if (!sysmem) throw new Error('no doctor row');
    expect(sysmem).toHaveAttribute('data-status', 'fail');
    expect(within(sysmem).getByText(/Prefer No Sysmem Fallback/)).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'Benchmark results' });
    // stage first, label second
    const infer = within(table).getByRole('rowheader', { name: /^infer\s*default$/ });
    expect(infer.querySelector('.bench-stage-name')).toHaveTextContent('infer');
    expect(infer.querySelector('.bench-stage-label')).toHaveTextContent('default');
    expect(within(table).getByRole('rowheader', { name: /^train\s*batch 4 \(s\/epoch\)$/ })).toBeInTheDocument();
    expect(within(table).getByText('0.16×')).toBeInTheDocument();
  });

  it('shows hints only for failing checks, and keeps long details whole (wrapped, full text in the title)', async () => {
    renderApp('/system');
    const ffmpeg = (await screen.findByText('ffmpeg')).closest('li');
    if (!ffmpeg) throw new Error('no ffmpeg row');
    const detail = within(ffmpeg).getByText(/ffmpeg\.exe$/);
    expect(detail).toHaveAttribute('title', detail.textContent);
    expect(ffmpeg.querySelector('.doctor-hint')).toBeNull();
    expect(document.querySelectorAll('.doctor-hint')).toHaveLength(1);
  });

  it('says so when no GPU is visible', async () => {
    server.use(http.get('/api/system/gpu', () => HttpResponse.json({ data: { available: false } })));
    renderApp('/system');
    expect(await screen.findByText(/No NVIDIA GPU is visible/)).toBeInTheDocument();
  });

  it('warns when VRAM is nearly full', async () => {
    server.use(http.get('/api/system/gpu', () => HttpResponse.json({
      data: { available: true, name: 'RTX', driver: '1', mem_total_mb: 6144, mem_used_mb: 5900, temp_c: 70, util: 99 },
    })));
    renderApp('/system');
    expect(await screen.findByText(/VRAM is nearly full/)).toBeInTheDocument();
  });
});
