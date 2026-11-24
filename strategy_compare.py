"""Fork a calibrated task for a matched-budget old/new strategy comparison."""

import argparse
import hashlib
import json
import shutil
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def state(task):
    run = task / "run"
    model = read(run / "dart/model.json")
    champion = read(run / "dart/champion.json")
    candidate_dirs = run / "candidates"
    evaluations = read(run / "evals" / f"{champion['id']}.json")["metrics"]["seed_results"]
    values = [
        (model["direction"] * case["score"] - anchor["low"]) / anchor["scale"]
        if case["judge"] == "ACCEPTED" else -2
        for anchor, case in zip(model["anchor"], evaluations, strict=True)
    ]
    tail = sorted(values)[: (len(values) + 4) // 5]
    budget = read(run / "budget.json")
    return {
        "protocol": read(run / "dart/protocol.json")["version"],
        "model": model["version"],
        "candidate_cap": budget["max"],
        "candidates": budget.get("trial_attempts", 0) + sum(
            p.is_dir() and p.name != "c000000" and p.name[1:].isdigit()
            for p in candidate_dirs.glob("c*")
        ),
        "seed_calls": read(run / "dart/budget.json")["used"],
        "champion": champion,
        "cvar": sum(tail) / len(tail),
    }


def fork(task, experiment):
    if task == experiment or task in experiment.parents:
        raise ValueError("Choose an experiment directory outside the source task")
    before = state(task)
    population = task / "run/population.jsonl"
    population_bytes = population.read_bytes()
    before["population_sha256"] = hashlib.sha256(population_bytes).hexdigest()
    experiment.mkdir(parents=True)
    target_name = task.name
    for arm in ("control", "treatment"):
        directory = experiment / arm / target_name
        shutil.copytree(task, directory)
        if state(directory) != {k: v for k, v in before.items() if k != "population_sha256"}:
            raise ValueError("Task changed during snapshot. Pause evolve_run before forking.")
        if hashlib.sha256((directory / "run/population.jsonl").read_bytes()).hexdigest() != before["population_sha256"]:
            raise ValueError("Population changed during snapshot. Pause evolve_run before forking.")
    (experiment / "strategy-comparison.json").write_text(
        json.dumps({"task": target_name, "baseline": before}, indent=2) + "\n", encoding="utf-8"
    )
    return {"control": str(experiment / "control" / target_name),
            "treatment": str(experiment / "treatment" / target_name)}


def compare(experiment):
    manifest = read(experiment / "strategy-comparison.json")
    before = manifest["baseline"]
    arms = {}
    for arm in ("control", "treatment"):
        after = state(experiment / arm / manifest["task"])
        if any(after[field] != before[field] for field in ("protocol", "model", "candidate_cap")):
            raise ValueError(f"{arm} used a different evaluation protocol, anchor model, or candidate cap")
        arms[arm] = {
            "candidates": after["candidates"] - before["candidates"],
            "seed_calls": after["seed_calls"] - before["seed_calls"],
            "champion": after["champion"],
            "fitness_gain": after["champion"]["fitness"] - before["champion"]["fitness"],
            "cvar_gain": after["cvar"] - before["cvar"],
        }
    control, treatment = arms["control"], arms["treatment"]
    matched = control["candidates"] == treatment["candidates"] and control["candidates"] > 0
    return {
        "matched_candidate_budget": matched,
        "matched_seed_calls": control["seed_calls"] == treatment["seed_calls"],
        "control": control,
        "treatment": treatment,
        "treatment_fitness_advantage": treatment["fitness_gain"] - control["fitness_gain"] if matched else None,
        "treatment_cvar_advantage": treatment["cvar_gain"] - control["cvar_gain"] if matched else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("fork")
    create.add_argument("task", type=Path)
    create.add_argument("experiment", type=Path)
    report = commands.add_parser("compare")
    report.add_argument("experiment", type=Path)
    args = parser.parse_args()
    result = (fork(args.task.resolve(), args.experiment.resolve())
              if args.command == "fork" else compare(args.experiment.resolve()))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

