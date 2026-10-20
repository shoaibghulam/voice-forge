/** Consent / rights notice (docs/01 "Ethics and rights"); must be acknowledged before converting. */
import { useId } from 'react';

interface EthicsNoticeProps {
  acknowledged: boolean;
  onChange: (value: boolean) => void;
}

export function EthicsNotice({ acknowledged, onChange }: EthicsNoticeProps) {
  const id = useId();
  return (
    <section className="ethics" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="ethics-title">Before you make a cover</h2>
      <ul className="ethics-list">
        <li>Have written consent from a living singer, or permission from a deceased singer’s family or estate.</li>
        <li>The new song’s composition and recording are protected even when the voice is not. Prefer traditional or estate-held compositions.</li>
        <li>Disclose that it is synthetic when you publish it (for example YouTube’s synthetic-content flag).</li>
        <li>Exported files carry a metadata tag marking them as AI-converted.</li>
      </ul>
      <label className="check ethics-check">
        <input type="checkbox" checked={acknowledged} onChange={(e) => onChange(e.target.checked)} />
        <span>I have the permissions above and will disclose that this cover is AI-converted.</span>
      </label>
    </section>
  );
}
