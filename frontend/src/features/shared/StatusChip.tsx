/** Job/run status as a chip: tone colour plus an icon and the word, never colour alone. */
import { statusIcon, statusTone } from './format';

interface StatusChipProps {
  status: string;
  /** Extra visually hidden context, e.g. "last run". */
  context?: string;
}

export function StatusChip({ status, context }: StatusChipProps) {
  return (
    <span className="chip" data-tone={statusTone(status)}>
      <span aria-hidden="true">{statusIcon(status)}</span>
      {context ? <span className="visually-hidden">{context}: </span> : null}
      {status}
    </span>
  );
}
