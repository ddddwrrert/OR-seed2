import gzip
import json
import os
import re
from pathlib import Path


def evaluate(program):
    value = int(re.search(r"^VALUE = (-?\d+)$", Path(program).read_text(), re.M)[1])
    seeds = json.loads(os.environ["OR_SEEDS"])
    fraction = 1
    cases = [
        {"seed": seed, "score": (seed + 1) * value, "judge": "ACCEPTED",
         "seconds": fraction / 10, "memory_bytes": 1024, "input_bytes": 2}
        for seed in seeds
    ]
    if os.environ.get("OR_TEST_REGRESSION") == "1":
        panels = {10: [100, 100, 100, 100], 15: [10000, 200, 200, 200], 30: [1, 190, 190, 190]}
        for case in cases:
            if value in panels and case["seed"] < 4:
                case["score"] = panels[value][case["seed"]]
    if os.environ.get("OR_TEST_CONFLICT") == "1":
        profiles = {10: [100, 100, 100, 100], 15: [140, 95, 105, 105], 20: [96, 160, 101, 100],
                    25: [120, 150, 107, 105], 30: [125, 155, 110, 108], 35: [130, 160, 111, 109]}
        for case in cases:
            if value in profiles and case["seed"] < 4:
                case["score"] = profiles[value][case["seed"]]
    with gzip.open(os.environ["OR_TRACE_FILE"], "wt") as trace:
        json.dump([{"seed": seed, "input": str(seed), "output": str(value)} for seed in seeds], trace)
    return {"score_direction": "maximize", "seed_results": cases,
            "combined_score": sum(case["score"] for case in cases) / len(cases)}

