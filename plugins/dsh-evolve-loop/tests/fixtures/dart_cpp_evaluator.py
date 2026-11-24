"""Compile and run candidate code on a small, deterministic scoring problem."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def evaluate(program):
    seeds = json.loads(os.environ["OR_SEEDS"])
    records = []
    with tempfile.TemporaryDirectory() as scratch:
        exe = Path(scratch) / ("candidate.exe" if os.name == "nt" else "candidate")
        command = ["g++", "-std=c++20", "-O2", program, "-o", str(exe)]
        if os.name == "nt":
            command.append("-static")
        compile_result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        for seed in seeds:
            started = time.monotonic()
            score, judge = 0, "COMPILE_ERROR"
            if compile_result.returncode == 0:
                try:
                    output = subprocess.run([str(exe)], input=f"{seed + 1}\n",
                                            capture_output=True, text=True, timeout=2)
                    value = int(output.stdout)
                    if output.returncode == 0 and value > 0:
                        score, judge = value, "ACCEPTED"
                    else:
                        judge = "WRONG_ANSWER"
                except ValueError:
                    judge = "WRONG_ANSWER"
                except subprocess.TimeoutExpired:
                    judge = "TIME_LIMIT_EXCEEDED"
            records.append({"seed": seed, "score": score, "judge": judge,
                            "seconds": time.monotonic() - started})
    return {"score_direction": "maximize", "seed_results": records,
            "combined_score": sum(record["score"] for record in records) / len(records)}
