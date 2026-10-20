/**
 * Stage catalogue (docs/04, docs/03 "Job model"): order per job type, short labels for
 * the signal path, and weights for the job bar when no `expected_s` is known yet.
 */
export const PREPARE_STAGES = ['validate', 'separate', 'dereverb', 'denoise', 'slice', 'qc'] as const;
export const TRAIN_STAGES = ['preprocess', 'extract', 'train', 'index', 'export', 'samples'] as const;
export const CONVERT_STAGES = ['separate', 'dereverb', 'convert', 'rereverb', 'mix', 'encode'] as const;
export const ANALYZE_STAGES = ['separate', 'lyrics', 'style', 'sections'] as const;

/**
 * Fallback stage list for a job type, used only until the job snapshot lists its own stages.
 * Preparing the dataset and training are separate jobs.
 */
export function stagesForJobType(type: string): string[] {
  if (type === 'prepare_dataset') return [...PREPARE_STAGES];
  if (type === 'train') return [...TRAIN_STAGES];
  if (type === 'convert') return [...CONVERT_STAGES];
  if (type === 'analyze') return [...ANALYZE_STAGES];
  return [];
}

const LABELS: Record<string, string> = {
  validate: 'validate',
  separate: 'separate',
  dereverb: 'de-echo',
  denoise: 'denoise',
  slice: 'slice',
  qc: 'QC',
  preprocess: 'prep',
  extract: 'pitch + feats',
  train: 'train',
  index: 'index',
  export: 'export',
  samples: 'samples',
  convert: 'convert',
  rereverb: 're-reverb',
  mix: 'mix',
  encode: 'encode',
  lyrics: 'lyrics',
  style: 'style',
  sections: 'timeline',
};

export function stageLabel(name: string): string {
  return LABELS[name] ?? name.replace(/_/g, ' ');
}

/** Rough relative cost, used only until `stage.started.expected_s` arrives. */
const WEIGHTS: Record<string, number> = {
  validate: 1, separate: 8, dereverb: 4, denoise: 4, slice: 1, qc: 3,
  preprocess: 2, extract: 4, train: 60, index: 1, export: 1, samples: 1,
  convert: 6, rereverb: 1, mix: 1, encode: 1,
  lyrics: 2, style: 2, sections: 1,
};

export function stageWeight(name: string): number {
  return WEIGHTS[name] ?? 2;
}
