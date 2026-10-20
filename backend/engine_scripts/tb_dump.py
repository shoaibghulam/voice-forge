"""Read Applio's TensorBoard events: new loss scalars and audio samples. Engine venv.

    python tb_dump.py --event-dir <run>/eval --after-step N --audio-dir <dir>

Prints JSON lines:
    {"event": "scalars", "step": 1200, "mel": .., "kl": .., "fm": .., "adv": ..,
     "g_total": .., "d_adv": .., "grad_g": .., "grad_d": ..}
    {"event": "audio", "step": 1380, "path": "<audio-dir>/sample_0001380.wav"}
Only steps after --after-step are printed; audio already written is skipped. The worker
calls this every few seconds while training runs (the API venv has no TensorBoard).
"""

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

from tensorboard.backend.event_processing.event_accumulator import EventAccumulator

TAGS = {
    "loss_avg_50/g/mel": "mel",
    "loss_avg_50/g/kl": "kl",
    "loss_avg_50/g/fm": "fm",
    "loss_avg_50/g/adv": "adv",
    "loss_avg_50/g/total": "g_total",
    "loss_avg_50/d/adv": "d_adv",
    "grad_avg_50/norm_g": "grad_g",
    "grad_avg_50/norm_d": "grad_d",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Dump new TensorBoard scalars and audio.")
    parser.add_argument("--event-dir", required=True, type=Path)
    parser.add_argument("--after-step", type=int, default=-1)
    parser.add_argument("--audio-dir", required=True, type=Path)
    args = parser.parse_args()
    if not args.event_dir.is_dir():
        return 0

    acc = EventAccumulator(str(args.event_dir), size_guidance={"scalars": 0, "audio": 0})
    acc.Reload()
    tags = acc.Tags()

    by_step: dict[int, dict[str, float]] = defaultdict(dict)
    for tag, name in TAGS.items():
        if tag in tags.get("scalars", []):
            for event in acc.Scalars(tag):
                if event.step > args.after_step and math.isfinite(event.value):
                    # NaN/inf (Applio's first grad norms) would be invalid JSON in a browser
                    by_step[event.step][name] = round(float(event.value), 5)
    for step in sorted(by_step):
        print(json.dumps({"event": "scalars", "step": step, **by_step[step]}), flush=True)

    args.audio_dir.mkdir(parents=True, exist_ok=True)
    for tag in tags.get("audio", []):
        for event in acc.Audio(tag):
            target = args.audio_dir / f"sample_{event.step:07d}.wav"
            if target.exists():
                continue
            target.write_bytes(event.encoded_audio_string)
            print(json.dumps({"event": "audio", "step": event.step, "path": str(target)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
