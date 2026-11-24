import gzip
import hashlib
import json
import logging
import os
import sys
import traceback
from pathlib import Path

from ale_bench.result import CaseResult, JudgeResult, Result
from ale_bench_eval.safe_ale_session import start_ale_bench_session

logger = logging.getLogger(__name__ + "_" + "ALE_BENCH_EVALUATOR")


def result_feedback(result: Result) -> CaseResult:
    if result.overall_judge_result == JudgeResult.ACCEPTED:
        return result.case_results[0]
    else:
        selected_case_idx = 0
        for idx, case_result in enumerate(result.case_results):
            if case_result.judge_result == result.overall_judge_result:
                selected_case_idx = idx
                break
        return result.case_results[selected_case_idx]


def evaluate(program_path):
    problem_id = "ahc027"
    logger.info(
        f"Evaluating program {program_path} for problem {problem_id} in ale bench evaluator"
    )
    session = None
    try:
        logger.info("Starting ALE-Bench session")
        session = start_ale_bench_session(
            problem_id=problem_id,
            lite_version=True,
            num_workers=13,
        )
        logger.info("ALE-Bench session started")
        if not session:
            raise RuntimeError("Failed to start or restart the session.")
        optim_factor = 1 if session.problem.metadata.score_type == "maximize" else -1
        code = (
            Path(program_path)
            .read_text()
            .replace("#EVOLVE_START", "")
            .replace("#EVOLVE_END", "")
            .strip()
        )
        logger.info("Code extracted")
        num_public_cases = 50
        seeds = json.loads(os.environ.get("OR_SEEDS", json.dumps(list(range(num_public_cases)))))
        fraction = float(os.environ.get("OR_BUDGET_FRACTION", "1"))
        cases = session.case_gen(seeds)
        public_result = session.case_eval(
            cases, code, code_language="cpp20", skip_local_visualization=True,
            time_limit=session.problem.constraints.time_limit * fraction if fraction != 1 else None,
        )
        logger.info("Public evaluation completed")
        extracted_case = result_feedback(public_result)
        logger.info("Result feedback completed")
        logger.info("ALE-Bench session closed")
        combined_score = public_result.overall_absolute_score * optim_factor / len(seeds)
        if public_result.overall_judge_result != JudgeResult.ACCEPTED and optim_factor == -1:
            combined_score = -sys.maxsize - 1
        traces = []
        seed_results = []
        for seed, instance, result in zip(seeds, cases, public_result.case_results, strict=True):
            seed_results.append({
                "seed": seed,
                "score": result.absolute_score,
                "judge": result.judge_result.value,
                "seconds": result.execution_time,
                "memory_bytes": result.memory_usage,
                "input_sha256": hashlib.sha256(instance.encode()).hexdigest(),
                "input_bytes": len(instance.encode()),
                "message": result.message[:400],
            })
            traces.append({
                "seed": seed, "input": instance, "output": result.output_str,
                "stderr": result.error_str, "message": result.message,
            })
        trace_path = os.environ.get("OR_TRACE_FILE")
        if trace_path:
            with gzip.open(trace_path, "wt", encoding="utf-8") as trace:
                json.dump(traces, trace, ensure_ascii=False)
        return {
            "seed_results": seed_results,
            "score_direction": "maximize" if optim_factor == 1 else "minimize",
            "budget_fraction": fraction,
            "resource_usage": public_result.resource_usage.model_dump(),
            "judge_result": public_result.overall_judge_result.value,
            "overall_score": public_result.overall_absolute_score,
            "max_execution_time_sec": max(
                [case_result.execution_time for case_result in public_result.case_results]
            ),
            "max_memory_usage_mib": max(
                [case_result.memory_usage for case_result in public_result.case_results]
            )
            // 1024
            // 1024,
            "standard_error": (extracted_case.error_str or "")[-2000:],
            "message": extracted_case.message[:400],
            "combined_score": combined_score,
        }
    except Exception as e:
        logger.error(f"Evaluation failed completely: {str(e)}")
        logger.error(traceback.format_exc())
        return {
            "overall_score": 0.0,
            "error": str(e),
        }
    finally:
        if session is not None:
            session.close()
