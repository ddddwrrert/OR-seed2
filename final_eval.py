"""Export the locally validated V4 submission. Legacy tasks retain their original final evaluation."""

import json
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

MARKERS = {b"#EVOLVE_START", b"#EVOLVE_END"}


def merit(fitness: float) -> float:
    """As the evolve loop ranks candidates (merit() in population.js): a failed evaluation (0)
    counts as 0, and a minimize task's scores, which its evaluator makes negative, as 1/|fitness|."""
    return fitness if fitness > 0 else -1 / fitness if fitness < 0 else 0.0


def export_dart(task: Path, settings: dict) -> None:
    run = task / "run"
    selection = json.loads((run / "dart/submission.json").read_text(encoding="utf-8"))
    candidate_id = selection["id"]
    if len(candidate_id) != 7 or not candidate_id.startswith("c") or not candidate_id[1:].isdigit():
        raise SystemExit("Invalid DART candidate ID")
    program = run / "candidates" / candidate_id / settings["program"]
    source = program.read_bytes()
    digest = hashlib.sha256(str(len(source)).encode() + b":" + source).hexdigest()
    if digest != selection["source_sha256"] or selection["validation"] != "LEGAL":
        raise SystemExit("DART selection does not match locally validated source")
    output = run / ("final-solution" + program.suffix)
    code = b"\n".join(line for line in source.split(b"\n") if line.strip() not in MARKERS)
    with tempfile.NamedTemporaryFile(dir=run, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(code)
    try:
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    report = dict(selection, output=output.name)
    (run / "final.txt").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Exported locally validated {candidate_id} ({selection['objective']}) to {output}")


def main() -> None:
    task = Path(sys.argv[1]).resolve()
    private_eval = Path(__file__).resolve().parent / "private_eval.py"
    settings = json.loads((task / "task.json").read_text(encoding="utf-8"))
    if settings.get("dart", {}).get("enabled"):
        export_dart(task, settings)
        return
    lines = (task / "run" / "population.jsonl").read_text(encoding="utf-8").splitlines()
    best = max((json.loads(line) for line in lines if line.strip()), key=lambda row: merit(row["fitness"]))
    program = task / "run" / "candidates" / best["id"] / settings["program"]
    code = b"\n".join(line for line in program.read_bytes().split(b"\n") if line.strip() not in MARKERS)

    with tempfile.TemporaryDirectory() as scratch:
        plain = Path(scratch) / program.name
        plain.write_bytes(code)
        completed = subprocess.run(
            [sys.executable, str(private_eval), "--program-path", str(plain), "--problem-id", task.name],
            cwd=private_eval.parent, stdout=subprocess.PIPE, text=True)

    report = f"best candidate: {best['id']} (fitness {best['fitness']})\n{completed.stdout}"
    (task / "run" / "final.txt").write_text(report, encoding="utf-8")
    print(report)
    sys.exit(completed.returncode)


if __name__ == "__main__":
    main()
