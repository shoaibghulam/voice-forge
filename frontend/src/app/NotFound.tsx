import { Link } from '@tanstack/react-router';

export function NotFound() {
  return (
    <section className="page" aria-labelledby="nf-title">
      <p className="eyebrow">404 · no signal</p>
      <h1 id="nf-title">Nothing is patched into this route.</h1>
      <p className="muted" style={{ marginTop: 'var(--space-4)' }}>
        <Link to="/">Back to the singers library</Link>
      </p>
    </section>
  );
}
