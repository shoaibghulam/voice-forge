"""Keeping the laptop awake while a job runs (docs/05 C5)."""

from app.worker.awake import ES_CONTINUOUS, ES_SYSTEM_REQUIRED, stay_awake


def test_requests_and_releases_the_awake_state() -> None:
    calls: list[int] = []

    with stay_awake(setter=calls.append):
        assert calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED]

    assert calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED, ES_CONTINUOUS]


def test_releases_even_when_the_job_raises() -> None:
    calls: list[int] = []

    try:
        with stay_awake(setter=calls.append):
            raise RuntimeError("stage crashed")
    except RuntimeError:
        pass

    assert calls[-1] == ES_CONTINUOUS


def test_is_a_no_op_without_a_setter() -> None:
    with stay_awake(setter=None):
        pass
