"""Job type -> ordered stages (docs/03 "Job model"). Stage names are the API contract:
the frontend draws the signal path from them."""

from app.worker.stage_runner import Pipeline
from app.worker.stages import analyze, convert, prepare, train, train_loop

PIPELINES: Pipeline = {
    "prepare_dataset": [
        ("validate", prepare.validate),
        ("separate", prepare.separate),
        ("dereverb", prepare.dereverb),
        ("denoise", prepare.denoise),
        ("slice", prepare.slice_clips),
        ("qc", prepare.qc),
    ],
    "train": [
        ("preprocess", train.preprocess),
        ("extract", train.extract),
        ("train", train_loop.train),
        ("index", train.index),
        ("export", train.export),
        ("samples", train.samples),
    ],
    "convert": [
        ("separate", convert.separate),
        ("dereverb", convert.dereverb),
        ("convert", convert.convert),
        ("rereverb", convert.rereverb),
        ("mix", convert.mix),
        ("encode", convert.encode),
    ],
    "analyze": [
        ("separate", analyze.separate),
        ("lyrics", analyze.lyrics),
        ("style", analyze.style),
        ("sections", analyze.sections),
    ],
}


def stage_names(job_type: str) -> list[str]:
    return [name for name, _ in PIPELINES[job_type]]
