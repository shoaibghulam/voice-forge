/**
 * Blind test: labels hidden, order reshuffled every round, guesses recorded, score at
 * the end. With the real voice included the question is "which is the real singer?"
 * (fooling you is good for the model); otherwise "which sounds more like them?".
 */
import { useMemo, useState } from 'react';
import { AbPlayer, type AbSource } from '@/components/AbPlayer';

interface BlindTestProps {
  sources: AbSource[];
  singerName: string;
  referenceKey: string | null;
  onExit: () => void;
}

const ROUNDS = 5;

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) { out[i] = b; out[j] = a; }
  }
  return out;
}

interface Guess {
  round: number;
  pickedKey: string;
}

function Score({ guesses, sources, referenceKey, singerName }: { guesses: Guess[]; sources: AbSource[]; referenceKey: string | null; singerName: string }) {
  if (referenceKey) {
    const spotted = guesses.filter((g) => g.pickedKey === referenceKey).length;
    return (
      <p className="blind-score">
        You picked the real {singerName} <span className="num">{spotted} of {guesses.length}</span> times.{' '}
        {spotted <= guesses.length / sources.length + 0.5
          ? 'That is about chance — the model is hard to tell apart.'
          : 'You can still hear the difference; compare later checkpoints.'}
      </p>
    );
  }
  return (
    <ul className="blind-tally">
      {sources.map((s) => (
        <li key={s.key}><span>{s.label}</span> <span className="num">{guesses.filter((g) => g.pickedKey === s.key).length} of {guesses.length}</span> picks</li>
      ))}
    </ul>
  );
}

export function BlindTest({ sources, singerName, referenceKey, onExit }: BlindTestProps) {
  const [round, setRound] = useState(1);
  const [guesses, setGuesses] = useState<Guess[]>([]);
  const order = useMemo(() => shuffle(sources), [sources, round]);
  const done = guesses.length >= ROUNDS;
  const masked: AbSource[] = order.map((s, i) => ({ key: s.key, url: s.url, label: `Option ${i + 1}` }));
  const question = referenceKey ? `Which one is the real ${singerName}?` : `Which one sounds more like ${singerName}?`;

  const guess = (key: string) => {
    setGuesses((prev) => [...prev, { round, pickedKey: key }]);
    setRound((r) => r + 1);
  };

  return (
    <section className="blind" aria-labelledby="blind-title">
      <div className="section-head">
        <h3 id="blind-title">Blind test</h3>
        <span className="num muted" aria-live="polite">{done ? 'finished' : `round ${round} of ${ROUNDS}`}</span>
      </div>
      {done ? (
        <div className="blind-result">
          <Score guesses={guesses} sources={sources} referenceKey={referenceKey} singerName={singerName} />
          <div className="inline-actions">
            <button type="button" className="btn" onClick={() => { setGuesses([]); setRound(1); }}>Run it again</button>
            <button type="button" className="btn btn-quiet" onClick={onExit}>Show labels</button>
          </div>
        </div>
      ) : (
        <>
          <AbPlayer key={round} sources={masked} label={`Blind round ${round}`} />
          <fieldset className="blind-guess">
            <legend>{question}</legend>
            <div className="inline-actions">
              {masked.map((s) => (
                <button key={s.key} type="button" className="btn" onClick={() => guess(s.key)}>{s.label}</button>
              ))}
            </div>
          </fieldset>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onExit}>Stop the blind test</button>
        </>
      )}
    </section>
  );
}
