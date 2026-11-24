"""Contract smoke tests for the pinned ALE adapters, without a Docker judge."""
import gzip
import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ACCEPTED = SimpleNamespace(value="ACCEPTED")


class AleAdapterTest(unittest.TestCase):
    def test_adapters_follow_requested_seed_order_and_write_raw_traces(self):
        for task in sorted((ROOT / "tasks/ale_bench").glob("ahc*")):
            with self.subTest(task=task.name), TemporaryDirectory() as scratch:
                sessions = []

                def start(**kwargs):
                    self.assertEqual(kwargs["problem_id"], task.name)

                    def case_eval(instances, code, **options):
                        self.assertEqual(instances, ["instance 9", "instance 3"])
                        self.assertEqual(code, "int main() {}")
                        self.assertNotIn("time_limit", options)
                        cases = [SimpleNamespace(
                            absolute_score=score, judge_result=ACCEPTED, execution_time=0.25,
                            memory_usage=1024, output_str="out", error_str="stderr", message="judge",
                        ) for score in [8, 30]]
                        return SimpleNamespace(
                            overall_judge_result=ACCEPTED, overall_absolute_score=38,
                            case_results=cases, resource_usage=SimpleNamespace(model_dump=lambda: {"num_case_eval": 2}),
                        )

                    session = SimpleNamespace(
                        problem=SimpleNamespace(metadata=SimpleNamespace(score_type="minimize"),
                                                constraints=SimpleNamespace(time_limit=2)),
                        case_gen=lambda seeds: [f"instance {seed}" for seed in seeds],
                        case_eval=case_eval, close=lambda: sessions.append("closed"),
                    )
                    return session

                ale = ModuleType("ale_bench.result")
                ale.CaseResult = ale.Result = object
                ale.JudgeResult = SimpleNamespace(ACCEPTED=ACCEPTED)
                safe = ModuleType("ale_bench_eval.safe_ale_session")
                safe.start_ale_bench_session = start
                trace = Path(scratch) / "trace.json.gz"
                program = Path(scratch) / "solution.cpp"
                program.write_text("int main() {}")
                with patch.dict("sys.modules", {ale.__name__: ale, safe.__name__: safe}), patch.dict(os.environ, {
                    "OR_SEEDS": "[9, 3]", "OR_TRACE_FILE": str(trace),
                }):
                    spec = importlib.util.spec_from_file_location(task.name, task / "evaluator/evaluator.py")
                    adapter = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(adapter)
                    result = adapter.evaluate(program)
                self.assertEqual(result["score_direction"], "minimize")
                self.assertEqual(result["combined_score"], -19)
                self.assertEqual([(case["seed"], case["score"]) for case in result["seed_results"]], [(9, 8), (3, 30)])
                self.assertEqual(sessions, ["closed"])
                with gzip.open(trace, "rt") as handle:
                    evidence = json.load(handle)
                self.assertEqual(evidence[0]["input"], "instance 9")
                self.assertEqual(evidence[0]["output"], "out")
                self.assertEqual(evidence[0]["stderr"], "stderr")


if __name__ == "__main__":
    unittest.main()

