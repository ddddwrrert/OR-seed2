import { cp, mkdir, mkdtemp, readFile, realpath, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'
import * as plugin from '../src/index.js'

const FIXTURE_TASK = fileURLToPath(new URL('./fixtures/task/', import.meta.url))
const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

let task: string
let ctx: Context
let evolve: any
let agent: any
let hasProvider: boolean
let starts: { request: any, order: string[] }[]
let worker: (request: any) => Promise<void>

async function setCandidateValue(dir: string, value: number): Promise<void> {
  const source = await readFile(join(dir, 'solution.py'), 'utf8')
  await writeFile(join(dir, 'solution.py'), source.replace(/^VALUE = -?\d+$/m, `VALUE = ${String(value)}`), 'utf8')
}

async function rows(): Promise<any[]> {
  const raw = await readFile(join(task, 'run', 'population.jsonl'), 'utf8')
  return raw.trim().split('\n').map(line => JSON.parse(line))
}

function subagentsService() {
  return {
    getProvider: (name: string) => (hasProvider && name === 'candidate-builder' ? { name } : undefined),
    async start(_name: string, request: any) {
      const order: string[] = []
      starts.push({ request, order })
      const result = (async () => {
        await worker(request)
        order.push('result')
        return { output: [{ type: 'text', text: 'report' }], stopReason: 'completed' }
      })()
      return {
        id: `child-${String(starts.length)}`,
        localAgent: undefined,
        result,
        async dispose() { order.push('dispose') },
      }
    },
  }
}

function runTool(args: Record<string, unknown>, signal = new AbortController().signal) {
  return ctx.tools.get('evolve_run')!.execute(args, {
    agent,
    callId: 'call-evolve_run',
    name: 'evolve_run',
    signal,
  } as never) as Promise<any>
}

beforeEach(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  task = await realpath(await mkdtemp(join(FIXTURE_ROOT, 'task-')))
  await cp(FIXTURE_TASK, task, { recursive: true })
  agent = { id: 'orchestrator', session: { id: 'orchestrator', header: { cwd: task } } }
  hasProvider = true
  starts = []
  worker = async (req) => {
    const id = req.confine.root.split(/[/\\]/).pop()
    const n = Number(id.replace('c', ''))
    await setCandidateValue(req.confine.root, 10 + n * 5)
  }

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Subprocess)
  await ctx.plugin({ name: 'test-subagents', apply: (scope: Context) => { scope.provide('subagents', subagentsService()) } })
  await ctx.plugin(DynamicCordisRunner)
  await ctx.plugin(plugin)
  evolve = ctx.get('evolve')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.fiber.dispose()
})

describe('dsh-evolve-loop', () => {
  it('creates baseline and runs search candidates returning best_id, best_fitness, remaining', async () => {
    const result = await runTool({
      max_budget: 3,
      max_population: 10,
      candidates: 2,
    })

    // Returned object matches user contract
    expect(result).toEqual({
      best_id: 'c000002',
      best_fitness: 20,
      remaining: 1,
    })

    // Check population records on disk
    const records = await rows()
    expect(records).toHaveLength(3) // c000000, c000001, c000002
    expect(records[0]).toEqual({ id: 'c000000', parent: null, fitness: 10, survival: 'yes' })
    expect(records[1]).toEqual({ id: 'c000001', parent: 'c000000', fitness: 15, survival: 'yes' })
    expect(records[2]).toMatchObject({ id: 'c000002', fitness: 20, survival: 'yes' })

    // The evaluator's full result is kept for each candidate
    const evaluation = JSON.parse(await readFile(join(task, 'run', 'evals', 'c000001.json'), 'utf8'))
    expect(evaluation).toEqual({ fitness: 15, metrics: { combined_score: 15 } })
  })

  it('confines a sandboxed task\'s evaluator through the asynchronous sandbox service', async () => {
    const confined: { policy: any, signal?: AbortSignal }[] = []
    await ctx.plugin({
      name: 'test-sandbox',
      apply: (scope: Context) => {
        scope.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
        // As DSH 0.1.7's SandboxProvider: confine resolves to the confined argv.
        scope.provide('sandbox', {
          async confine(argv: readonly string[], policy: any, signal?: AbortSignal) {
            confined.push({ policy, signal })
            return { argv: [...argv] }
          },
        })
      },
    })

    // The fixture task has "sandbox": true, so the baseline and c000001 both run confined
    const result = await runTool({ max_budget: 1 })

    expect(result).toEqual({ best_id: 'c000001', best_fitness: 15, remaining: 0 })
    expect(confined).toHaveLength(2)
    expect(confined[0].policy).toMatchObject({ mode: 'workspace-write' })
    expect(confined[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('ranks a failed evaluation (0) last on a minimize task, whose scores are negative', async () => {
    const scores: Record<string, number> = { c000000: -10, c000001: 0, c000002: -5, c000003: -20 }
    evolve.register('evaluate', { name: 'minimize-scores', async evaluate({ id }: any) { return scores[id] } })

    const result = await runTool({ max_budget: 3, max_population: 3, k: 2 })

    // The failed c000001 is neither reported as best nor kept by a cull
    expect(result).toEqual({ best_id: 'c000002', best_fitness: -5, remaining: 0 })
    expect((await rows()).filter(r => r.survival === 'yes').map(r => r.id)).toEqual(['c000000', 'c000002'])
  })

  it('stops the run when the task evaluator cannot be loaded', async () => {
    await writeFile(join(task, 'evaluator', 'evaluator.py'), 'import no_such_module\n', 'utf8')
    await expect(runTool({ max_budget: 1 }))
      .rejects.toThrow(/did not run on c000000[\s\S]*no_such_module/)
  })

  it('exhausts budget and enforces max_budget consistency', async () => {
    const first = await runTool({
      max_budget: 2,
      candidates: 1,
    })
    expect(first.remaining).toBe(1)

    const second = await runTool({
      max_budget: 2,
    })
    expect(second.remaining).toBe(0)
    expect(second.best_fitness).toBe(20)

    // Cannot change max_budget
    await expect(runTool({
      max_budget: 5,
    })).rejects.toThrow(/the budget for this run is already 2/)
  })

  it('applies default max_population = 10 and k = 5 when omitted', async () => {
    const result = await runTool({
      max_budget: 11, // baseline (0) + 11 candidates = 12 total entries
    })

    expect(result.best_id).toBe('c000011')
    expect(result.best_fitness).toBe(65)

    const records = await rows()
    expect(records).toHaveLength(12) // baseline + 11 candidates
    const aliveRecords = records.filter(r => r.survival === 'yes')
    expect(aliveRecords.length).toBeLessThanOrEqual(10)
    // 5 survivors from cull at 10 candidates + candidate 10 + candidate 11 = 7 alive
    expect(aliveRecords.length).toBe(7)
  })

  it('validates tool arguments', async () => {
    await expect(runTool({ max_budget: 0 }))
      .rejects.toThrow('maxBudget must be a positive integer')
    await expect(runTool({ max_budget: 10, max_population: 0 }))
      .rejects.toThrow('maxPopulation must be a positive integer')
  })

  it('renders clean high-signal text for the model', async () => {
    const tool = ctx.tools.get('evolve_run')!
    const rendered = tool.output.render({}, {
      best_id: 'c000003',
      best_fitness: 45.5,
      remaining: 8,
    })
    expect(rendered).toEqual([{
      type: 'text',
      text: 'Best candidate c000003 (fitness 45.5); 8 of budget remaining.\n\n'
        + 'Reminder: before changing the search, load the improving-the-search-strategy skill again; '
        + 'its content may no longer be in your context.',
    }])
  })

  it('tolerates worker crash and evaluates candidate as-is', async () => {
    worker = async () => {
      throw new Error('worker python process failed')
    }
    const result = await runTool({
      max_budget: 1,
    })
    expect(result.best_id).toBe('c000000')
    expect(result.remaining).toBe(0)

    const records = await rows()
    expect(records).toHaveLength(2)
    expect(records[1].id).toBe('c000001')
    expect(records[1].fitness).toBe(10)
  })

  it('stops when the call is aborted, and releases the run', async () => {
    const controller = new AbortController()
    evolve.register('mutate', async () => {
      controller.abort()
    })
    await expect(runTool({ max_budget: 3 }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })

    expect(() => evolve.currentRun()).toThrow('no evolve run is in progress')
  })

  it('fails loud when missing candidate-builder subagent provider', async () => {
    hasProvider = false
    await expect(runTool({ max_budget: 2 }))
      .rejects.toThrow('evolve needs the "candidate-builder" subagent provider')
  })

  it('refuses concurrent runs', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve })

    evolve.register('mutate', async ({ parent }: any, evolveSvc: any) => {
      entered()
      await gate
      const cand = await evolveSvc.allocate(parent)
      return cand
    })

    const first = runTool({ max_budget: 1 })
    await inside
    await expect(runTool({ max_budget: 1 })).rejects.toThrow('already in progress')
    release()
    await expect(first).resolves.toBeDefined()
  })
})

describe('DART through evolve_run', () => {
  async function setupDart(maxSeedCalls?: number) {
    const path = join(task, 'task.json')
    const config = JSON.parse(await readFile(path, 'utf8'))
    config.dart = { enabled: true, allow_generated_probes: true, seeds: [0, 1, 2, 3], validation_seeds: [50, 51],
      max_seed_calls: maxSeedCalls }
    await writeFile(path, JSON.stringify(config))
    await cp(join(FIXTURE_TASK, '..', 'dart_evaluator.py'), join(task, 'evaluator', 'evaluator.py'))
  }

  async function report(relative: string) {
    return JSON.parse(await readFile(join(task, 'run', relative), 'utf8'))
  }

  it('pins probes across chunks, runs mutation, reuses traces and promotes via held-out evidence', async () => {
    await setupDart()
    const first = await runTool({ max_budget: 5, candidates: 2 })
    expect(first.best_id).toBe('c000000')
    expect(first.remaining).toBe(3)
    expect(starts[0].request.label).toBe('probe-greedy')

    const second = await runTool({ max_budget: 5, candidates: 2 })
    expect(second.best_id).toBe('c000004')
    expect(second.champion_certified).toBe(true)
    const calibration = await report('dart/model.json')
    expect(calibration.panel).toHaveLength(3)
    expect(calibration.cases[0].observations).toBe(6)
    expect((await report('dart/evidence/c000001-probe-0.5.json')).metrics.seed_results[0].seconds).toBe(0.05)
    expect((await report('dart/evidence/c000004-validation-1.json')).metrics.seed_results.map((s: any) => s.seed)).toEqual([50, 51])
    const result = await report('evals/c000004.json')
    expect(result.metrics.seed_results.map((s: any) => s.score)).toEqual([30, 60, 90, 120])
    expect((await readFile(join(task, 'run', result.trace), 'utf8')).length).toBeGreaterThan(0)

    worker = async req => setCandidateValue(req.confine.root, 30)
    const last = await runTool({ max_budget: 5 })
    expect(last.best_id).toBe('c000004')
    expect(last.remaining).toBe(0)
    expect((await report('evals/c000005.json')).cache_hit).toBe(true)
    expect(await report('dart/model.json')).toEqual(calibration)
  }, 45_000)

  async function configureFixedProbes() {
    await setupDart()
    const programs = { greedy: 'greedy.cpp', multistart: 'multistart.cpp', refinement: 'refinement.cpp' }
    const path = join(task, 'task.json')
    const config = JSON.parse(await readFile(path, 'utf8'))
    config.dart.probe_programs = programs
    delete config.dart.allow_generated_probes
    await writeFile(path, JSON.stringify(config))
    return Object.values(programs)
  }

  it('calibrates from authored probe files without calling a worker', async () => {
    const programs = await configureFixedProbes()
    for (const [index, program] of programs.entries()) {
      await writeFile(join(task, 'evaluator', program), `VALUE = ${15 + index}\n`)
    }
    await runTool({ max_budget: 6, candidates: 3 })
    const model = await report('dart/model.json')
    expect(model.calibration_status).toBe('fixed')
    expect(model.cases[0]).toMatchObject({ full_observations: 3, budget_pairs: 3 })
    expect(starts).toHaveLength(0)
  }, 45_000)

  it('rejects an incomplete fixed probe panel before spending a candidate', async () => {
    await configureFixedProbes()
    await expect(runTool({ max_budget: 6, candidates: 3 })).rejects.toThrow('fixed probe is missing')
    expect(starts).toHaveLength(0)
  })

  it('does not spend a candidate when case budget is exhausted by the baseline', async () => {
    await setupDart(6)
    const result = await runTool({ max_budget: 3 })
    expect(result).toMatchObject({ best_id: 'c000000', remaining: 3, seed_remaining: 0, seed_budget_exhausted: true })
    expect(starts).toHaveLength(0)
  })

  it('activates and rolls back a trial using the real DSH runtime runner', async () => {
    await setupDart()
    await runTool({ max_budget: 7, candidates: 3 })
    const invoke = (name: string, args: object) => ctx.tools.get(name)!.execute(args as never, {
      agent, callId: name, name, signal: new AbortController().signal,
    } as never)
    const defined: any = await invoke('evolve_define', {
      name: 'test-select', purpose: 'compare fixed baseline selection', host_code: `
        return { name: 'test-select', inject: ['evolve'], apply(ctx) {
          ctx.effect(() => ctx.evolve.register('select', { name: 'trial-select', async select() {
            return 'c000000'
          } }))
        } }
      `,
    })
    expect(await invoke('evolve_activate', { plugin_id: defined.plugin_id })).toMatchObject({ ok: true, dart_trial: 'pending' })
    expect(evolve.getProvider('select').name).toBe('trial-select')
    worker = async req => setCandidateValue(req.confine.root, 10)
    const run = join(task, 'run')
    const before = await readFile(join(run, 'population.jsonl'), 'utf8')
    const trial = await runTool({ max_budget: 7, candidates: 4 })
    expect(trial.dart_trial.status).toBe('rolled_back')
    expect(trial.dart_trial).toMatchObject({
      candidate_limit_per_arm: 2, control: { attempts: 2 }, treatment: { attempts: 2 },
    })
    expect(trial.remaining).toBe(0)
    expect(await readFile(join(run, 'population.jsonl'), 'utf8')).toBe(before)
    await expect(readFile(join(run, 'dart', 'mutations.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(evolve.getProvider('select').name).toBe('fitness-proportional')
  }, 45_000)

  it('adopts a certified treatment only when it beats the matched control', async () => {
    await setupDart()
    await runTool({ max_budget: 8, candidates: 3 })
    const invoke = (name: string, args: object) => ctx.tools.get(name)!.execute(args as never, {
      agent, callId: name, name, signal: new AbortController().signal,
    } as never)
    const defined: any = await invoke('evolve_define', {
      name: 'winning-arm', purpose: 'choose the higher scoring fixture worker', host_code: `
        return { name: 'winning-arm', inject: ['evolve'], apply(ctx) {
          ctx.effect(() => ctx.evolve.register('dart-arm', {
            name: 'winning-arm', run() { return 'generalize' }
          }))
        } }
      `,
    })
    await invoke('evolve_activate', { plugin_id: defined.plugin_id })
    worker = async req => setCandidateValue(req.confine.root, req.label === 'dart-generalize' ? 55 : 10)
    const response = await runTool({ max_budget: 8, candidates: 1 })
    expect(response.dart_trial.status).toBe('validated')
    expect(response.best_id).toBe('c000004')
    expect(response.remaining).toBe(3)
    expect(evolve.getProvider('dart-arm').name).toBe('winning-arm')
    const population = await readFile(join(task, 'run', 'population.jsonl'), 'utf8')
    expect(population).toContain('"trial_parent"')
    await expect(readFile(join(task, 'run', 'dart', 'mutations.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it('runs an independent DART component provided by a dynamic plugin and restores the default', async () => {
    await setupDart()
    await runTool({ max_budget: 8, candidates: 3 })
    const invoke = (name: string, args: object) => ctx.tools.get(name)!.execute(args as never, {
      agent, callId: name, name, signal: new AbortController().signal,
    } as never)
    const defined: any = await invoke('evolve_define', {
      name: 'generalize-arm', purpose: 'validate standalone dispatch component',
      host_code: `
        return { name: 'generalize-arm', inject: ['evolve'], apply(ctx) {
          ctx.effect(() => ctx.evolve.register('dart-arm', {
            name: 'generalize-only',
            async run({ eligible }, evolve) {
              const fallback = await evolve.dartComponent('dart-arm', {
                eligible, events: [], context: 'default',
              }, { defaultProvider: true })
              return eligible.includes('generalize') ? 'generalize' : fallback
            }
          }))
        } }
      `,
    })
    expect(await invoke('evolve_activate', { plugin_id: defined.plugin_id })).toMatchObject({
      ok: true, dart_trial: 'pending', changed: { 'dart-arm': { after: ['default', 'generalize-only'] } },
    })
    worker = async req => setCandidateValue(req.confine.root, 10)
    const output = await runTool({ max_budget: 8, candidates: 1 })
    expect(starts.at(-1)?.request.label).toBe('dart-generalize')
    expect(output.dart_trial.status).toBe('rolled_back')
    expect(evolve.getProvider('dart-arm').name).toBe('default')
  }, 45_000)

  it('restores the old strategy after a branch error without retaining branch state', async () => {
    await setupDart()
    await runTool({ max_budget: 6, candidates: 3 })
    const invoke = (name: string, args: object) => ctx.tools.get(name)!.execute(args as never, {
      agent, callId: name, name, signal: new AbortController().signal,
    } as never)
    const defined: any = await invoke('evolve_define', {
      name: 'broken-trial', purpose: 'simulate a failed strategy', host_code: `
        return { name: 'broken-trial', inject: ['evolve'], apply(ctx) {
          ctx.effect(() => ctx.evolve.register('dart-arm', {
            name: 'broken-trial', run() { throw new Error('branch failed') }
          }))
        } }
      `,
    })
    await invoke('evolve_activate', { plugin_id: defined.plugin_id })
    const population = join(task, 'run', 'population.jsonl')
    const before = await readFile(population, 'utf8')
    await expect(runTool({ max_budget: 6, candidates: 1 })).rejects.toThrow('branch failed')
    expect(evolve.getProvider('dart-arm').name).toBe('default')
    expect(await readFile(population, 'utf8')).toBe(before)
    const budget = await report('budget.json')
    expect(budget.trial_attempts).toBe(1)
  }, 45_000)

  it('hard-caps candidate allocation even when a trial loop ignores the requested limit', async () => {
    await setupDart()
    await runTool({ max_budget: 12, candidates: 3 })
    const dispose = evolve.register('loop', async (_args: unknown, service: any) => {
      const outcomes = await Promise.allSettled(Array.from({ length: 7 }, async () => service.allocate('c000000')))
      const failures = outcomes.filter(outcome => outcome.status === 'rejected')
      expect(failures).toHaveLength(4)
      if (failures[0]?.status === 'rejected') throw failures[0].reason
    })
    try {
      await expect(evolve.run({ maxBudget: 12, candidates: 9, dartTrial: true }, { agent }))
        .rejects.toThrow('candidate budget exhausted')
      const directories = await readdir(join(task, 'run', 'candidates'))
      expect(directories.filter(name => /^c\d{6}$/.test(name))).toHaveLength(7)
    } finally {
      dispose()
    }
    const result = await runTool({ max_budget: 12, candidates: 1 })
    expect(result.remaining).toBe(5)
  }, 45_000)

  it('rejects actual championship promotion when an easy seed collapses', async () => {
    await setupDart()
    const path = join(task, 'task.json')
    const config = JSON.parse(await readFile(path, 'utf8'))
    config.env = { OR_TEST_REGRESSION: '1' }
    await writeFile(path, JSON.stringify(config))
    await runTool({ max_budget: 5, candidates: 3 })
    const result = await runTool({ max_budget: 5, candidates: 1 })
    expect(result.best_id).not.toBe('c000004')
    const decisions = (await readFile(join(task, 'run', 'dart', 'promotions.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    expect(decisions).toContainEqual(expect.objectContaining({
      challenger: 'c000004', certified: false, reason: 'fixed raw easy-case floor',
    }))
  }, 45_000)

})
