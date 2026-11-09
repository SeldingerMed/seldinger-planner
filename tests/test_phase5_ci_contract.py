"""Keep the optional model-free Phase5 producers exercised in native CI."""

from pathlib import Path


def test_phase5_model_free_checks_are_wired_to_the_locked_native_runtime():
    root = Path(__file__).resolve().parents[1]
    workflow = (root / ".github/workflows/native-physics.yml").read_text()
    assert "uv sync --frozen --group dev" in workflow  # real default API tracer's interpreter
    assert "uv venv --python 3.11 .runtime/ml-runtime" in workflow
    assert (
        "uv pip sync --python .runtime/ml-runtime/bin/python --require-hashes requirements/physics.txt"
        in workflow
    )
    for name in (
        "test_anatomy_proposals.py",
        "test_anatomy_proposal_geometry.py",
        "test_anatomy_worker.py",
        "test_anatomy_default_path.py",
        "test_model_evaluation.py",
        "test_source_context.py",
        "test_phase5_worker.py",
    ):
        assert f"tests/ml_runtime/{name}" in workflow
