import json
import tempfile
import unittest
from pathlib import Path

from strategy_compare import compare, fork


class StrategyComparisonTest(unittest.TestCase):
    def test_forks_same_state_and_reports_matching_candidate_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            task = root / "ahc008"
            run = task / "run"

            def write(base, name, value):
                path = base / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(value), encoding="utf-8")

            def candidate(base, candidate_id, score):
                (base / "candidates" / candidate_id).mkdir(parents=True)
                write(base, "dart/champion.json", {"id": candidate_id, "fitness": score, "certified": True})
                write(base, f"evals/{candidate_id}.json", {
                    "metrics": {"seed_results": [{"judge": "ACCEPTED", "score": score}]}
                })

            write(run, "budget.json", {"max": 12})
            write(run, "dart/model.json", {"version": "model", "direction": 1,
                                           "anchor": [{"low": 100, "scale": 20}]})
            write(run, "dart/protocol.json", {"version": "protocol"})
            write(run, "dart/budget.json", {"used": 50})
            candidate(run, "c000000", 100)
            write(run, "population.jsonl", {"id": "c000000"})
            experience = root / "paired"
            paths = fork(task, experience)

            control = Path(paths["control"]) / "run"
            treatment = Path(paths["treatment"]) / "run"
            candidate(control, "c000001", 110)
            candidate(treatment, "c000001", 120)
            write(control, "dart/budget.json", {"used": 55})
            write(treatment, "dart/budget.json", {"used": 55})
            result = compare(experience)
            self.assertTrue(result["matched_candidate_budget"])
            self.assertTrue(result["matched_seed_calls"])
            self.assertEqual(result["treatment_fitness_advantage"], 10)
            self.assertEqual(result["treatment_cvar_advantage"], 0.5)

            candidate(treatment, "c000002", 130)
            self.assertFalse(compare(experience)["matched_candidate_budget"])
            self.assertIsNone(compare(experience)["treatment_fitness_advantage"])

