"""Install-time model downloads and the doctor's view of them: jobs never download
mid-run, so everything a pipeline loads must be fetchable (and checkable) up front."""

from app.config import Settings
from app.services.system import doctor
from app.worker import fetch_models
from app.worker.stages import analyze, prepare


def test_separation_list_covers_every_pipeline_model() -> None:
    missing = fetch_models.missing_models(set())

    assert set(prepare.ALL_MODELS) <= set(missing)
    assert analyze.HTDEMUCS in missing
    assert len(missing) == len(set(missing))


def test_present_models_are_not_fetched_again() -> None:
    present = {*prepare.ALL_MODELS, *analyze.ANALYSIS_MODELS}

    assert fetch_models.missing_models(present) == []


def test_analysis_models_are_found_by_their_marker_files(settings: Settings) -> None:
    assert fetch_models.missing_analysis_models(settings) == ["whisper", "clap"]

    settings.whisper_models_dir.mkdir(parents=True)
    (settings.whisper_models_dir / "model.bin").write_bytes(b"x")
    settings.clap_models_dir.mkdir(parents=True)
    (settings.clap_models_dir / "config.json").write_text("{}")

    assert fetch_models.missing_analysis_models(settings) == []


def test_doctor_reports_the_analysis_models(settings: Settings) -> None:
    checks = {c["id"]: c for c in doctor(settings)["checks"]}  # type: ignore[union-attr]

    assert checks["analysis_models"]["ok"] is False
    assert "whisper" in str(checks["analysis_models"]["detail"])
    assert "htdemucs_ft.yaml" in str(checks["separator_models"]["detail"])
