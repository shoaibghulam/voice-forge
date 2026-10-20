/**
 * A singer's progress as a tiny static signal path: songs → dataset → train → voice.
 * Nodes are filled when done, ringed when in progress; the text equivalent is read out.
 */
import type { Singer } from '@/api/schemas';
import { MIN_MINUTES } from '@/features/shared/format';

type NodeState = 'done' | 'active' | 'partial' | 'pending';

interface PathNode {
  label: string;
  state: NodeState;
}

export function singerPath(singer: Singer): PathNode[] {
  const minutes = singer.usable_minutes ?? 0;
  const lastType = singer.last_job?.type;
  const lastStatus = singer.last_job?.status ?? singer.last_job_status;
  const running = lastStatus === 'running' || lastStatus === 'queued';
  const datasetState: NodeState = running && lastType === 'prepare_dataset'
    ? 'active'
    : minutes >= MIN_MINUTES ? 'done' : minutes > 0 ? 'partial' : 'pending';
  const trainState: NodeState = running && lastType === 'train'
    ? 'active'
    : singer.model_count > 0 ? 'done' : 'pending';
  return [
    { label: 'songs', state: (singer.song_count ?? 0) > 0 ? 'done' : 'pending' },
    { label: 'dataset', state: datasetState },
    { label: 'train', state: trainState },
    { label: 'voice', state: singer.active_checkpoint_id ? 'done' : 'pending' },
  ];
}

const STATE_TEXT: Record<NodeState, string> = {
  done: 'done', active: 'in progress', partial: 'too short', pending: 'not yet',
};

interface MiniPathProps {
  singer: Singer;
}

export function MiniPath({ singer }: MiniPathProps) {
  const nodes = singerPath(singer);
  return (
    <ol className="mini-path" aria-label={`${singer.name} progress`}>
      {nodes.map((node) => (
        <li key={node.label} className="mini-node" data-state={node.state} title={`${node.label}: ${STATE_TEXT[node.state]}`}>
          <span className="mini-dot" aria-hidden="true" />
          <span className="visually-hidden">{node.label}: {STATE_TEXT[node.state]}</span>
        </li>
      ))}
    </ol>
  );
}
