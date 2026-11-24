/**
 * Default evaluate provider: scores a candidate with its task's evaluator
 * (<task>/evaluator/evaluator.py) through run_evaluator.py, which follows
 * SkyDiscover's Evaluator. The task's settings are in <task>/task.json:
 * `program` (the file that evolves), `timeout` and `max_retries` (as in
 * SkyDiscover's evaluator config), `sandbox` (whether the evaluator runs in
 * DSH's sandbox) and `env` (environment for the evaluator).
 *
 * @module dsh-evolve-loop/providers/evaluate
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { hash, readJson, reserve, usable, writeJson } from '../dart/store.js'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'python-subprocess'

const RUNNER = fileURLToPath(new URL('./run_evaluator.py', import.meta.url))
const STDOUT_MAX_BYTES = 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024
const GRACE_MS = 2000
// run_evaluator.py enforces the task's timeout; this only ends a runner that outlives all its attempts.
const RUNNER_MARGIN_MS = 60_000

/**
 * Score a candidate: the evaluator's result is saved to run/evals/<id>.json and its fitness returned.
 * @param {{ id: string, dir: string }} candidate
 * @param {object} evolve - the evolve service.
 * @returns {Promise<number>}
 */
export async function evaluate(candidate, evolve) {
  const evidence = await evaluateResult(candidate, evolve)
  return evidence.fitness
}

export async function evaluateResult(candidate, evolve, options = {}) {
  const { task, agent, signal, dart } = evolve.currentRun()
  signal.throwIfAborted()
  const ctx = evolve.ctx
  const settings = JSON.parse(await readFile(join(task, 'task.json'), 'utf8'))

  const fraction = options.fraction ?? 1
  const seeds = options.seeds ?? dart?.protocol.seeds
  const purpose = options.purpose ?? 'search'
  const record = purpose === 'search' ? `evals/${candidate.id}.json` :
    `dart/evidence/${candidate.id}-${purpose}-${fraction}.json`
  let cache
  let sourceHash
  if (dart) {
    const source = await readFile(join(candidate.dir, settings.program))
    sourceHash = hash([source])
    const key = hash([dart.protocol.version, JSON.stringify(seeds), String(fraction), source])
    cache = `dart/cache/${key}.json`
    const hit = settings.dart.disable_cache ? undefined : await readJson(evolve.files, cache)
    if (hit) {
      const evidence = { ...hit, cache_hit: true, purpose }
      await writeJson(evolve.files, record, evidence)
      return evidence
    }
    await reserve(evolve, seeds.length, `${candidate.id}/${purpose}/${fraction}`)
  }

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('the default evaluate needs the subprocess service')
  const python = await subprocess.resolveExecutable('python', undefined, signal)

  // The evaluator's temporary files, and the only place it may write when sandboxed.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'evolve-eval-')))
  try {
    let argv = [python, '-B', RUNNER, task, join(candidate.dir, settings.program)]
    if (settings.sandbox) {
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      if (policy !== undefined && policy.mode !== 'danger-full-access') {
        const sandbox = ctx.get('sandbox')
        if (sandbox === undefined) throw new Error(`sandbox mode "${policy.mode}" needs the sandbox service`)
        argv = (await sandbox.confine(argv, { ...policy, workspaceRoot: scratch }, signal)).argv
      }
    }

    const limitMs = settings.timeout * (settings.max_retries + 1) * 1000 + RUNNER_MARGIN_MS
    const trace = join(scratch, 'trace.json.gz')
    const started = Date.now()
    const handle = subprocess.spawn({
      argv,
      cwd: join(task, 'evaluator'),
      env: {
        ...settings.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch,
        ...(dart ? {
          OR_SEEDS: JSON.stringify(seeds), OR_BUDGET_FRACTION: String(fraction),
          OR_TRACE_FILE: trace, OR_SINGLE_ATTEMPT: '1',
        } : {}),
      },
      stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
      graceMs: GRACE_MS,
      signal: AbortSignal.any([signal, AbortSignal.timeout(limitMs)]),
    })
    const outcome = await handle.done
    signal.throwIfAborted()

    const stdout = handle.collected.stdout.readFrom(0).text.trim()
    if (outcome.exitCode !== 0 || stdout === '') {
      const stderr = handle.collected.stderr.readFrom(0).text.trim()
      throw new Error(`the evaluator of ${task} did not run on ${candidate.id} `
        + `(exit ${String(outcome.exitCode ?? outcome.signal)})${stderr === '' ? '' : `:\n${stderr.slice(-2000)}`}`)
    }
    const result = JSON.parse(stdout.split(/\r?\n/).pop())
    if (!dart) {
      await writeJson(evolve.files, record, result)
      return result
    }
    const evidence = {
      ...result, elapsed_ms: Date.now() - started, protocol: dart.protocol.version,
      source_sha256: sourceHash, purpose, cache_hit: false,
    }
    try {
      const bytes = await readFile(trace)
      evidence.trace = cache.replace('.json', '.trace.json.gz.b64')
      await evolve.files.write(evidence.trace, bytes.toString('base64'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await writeJson(evolve.files, record, evidence)
    if (usable(evidence, seeds) && !settings.dart.disable_cache &&
        !evidence.metrics.seed_results.some(item => item.judge === 'TIME_LIMIT_EXCEEDED')) {
      await writeJson(evolve.files, cache, evidence)
    }
    return evidence
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export default { name, evaluate }
