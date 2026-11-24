import { cp, mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BUDGET_FILE, budgetStatus } from '../budget.js'
import { candidatePath } from '../candidates.js'
import { filesOf } from '../files.js'
import { acceptedCase, evaluateChannels, mean } from './model.js'
import { readJson, writeJson } from './store.js'

const CHAMPION = 'dart/champion.json'
const SEED_BUDGET = 'dart/budget.json'
const TRIALS = 'dart/trials'

async function runArm({ name, root, directory, args, run, before, seedBudget, seedAllowance, activate }) {
  const trialRoot = join(directory, name)
  await mkdir(join(trialRoot, 'dart'), { recursive: true })
  for (const entry of await readdir(root)) {
    if (entry !== 'dart') await cp(join(root, entry), join(trialRoot, entry), { recursive: true })
  }
  for (const entry of await readdir(join(root, 'dart'))) {
    if (entry !== 'trials') await cp(join(root, 'dart', entry), join(trialRoot, 'dart', entry), { recursive: true })
  }
  const priorEvents = (await filesOf(trialRoot).read('dart/mutations.jsonl') ?? '').split('\n').filter(Boolean).length
  let summary
  let error
  try {
    await activate?.()
    summary = await run(args, { trialRoot, trialSeedCap: seedBudget.used + seedAllowance })
  } catch (failure) {
    error = failure
  }
  const files = filesOf(trialRoot)
  return {
    files, summary, error, priorEvents,
    champion: await readJson(files, CHAMPION),
    attempts: (await budgetStatus(trialRoot, before.max)).used - before.used,
    seedCalls: (await readJson(files, SEED_BUDGET)).used - seedBudget.used,
  }
}

async function comparison(control, treatment, old, model) {
  const arms = [control, treatment]
  const histories = await Promise.all(arms.map(async arm => {
    const rows = (await arm.files.read('dart/mutations.jsonl') ?? '').split('\n').filter(Boolean).map(JSON.parse)
    return rows.slice(arm.priorEvents)
  }))
  const initial = await readJson(control.files, `evals/${old.id}.json`)
  const champions = await Promise.all(arms.map(arm => readJson(arm.files, `evals/${arm.champion.id}.json`)))
  const panels = await Promise.all(histories.map((events, index) => Promise.all(events.map(event =>
    readJson(arms[index].files, `evals/${event.id}.json`)))))
  const shared = { ...model, anchor: model.anchor.map((anchor, index) => {
    const candidates = [...champions, ...panels.flat()].map(result => result?.metrics?.seed_results?.[index]).filter(acceptedCase)
    const values = [anchor.localBest, ...candidates.map(item => item.score)].filter(value => value !== null)
    return { ...anchor, localBest: model.direction * Math.max(...values.map(value => value * model.direction)) }
  }) }
  const metrics = arms.map((arm, index) => {
    const raw = champions[index].metrics.seed_results
    const channel = evaluateChannels({ raw, fitness: arm.champion.fitness }, shared)
    const cost = arm.seedCalls + histories[index].reduce((sum, event) => sum + (event.elapsed_ms ?? 0) / 1000, 0)
    const basis = initial.fitness
    const oldIds = new Set(histories[index].map(event => event.id))
    return {
      original_gain: channel.original_score - basis,
      gain_per_budget: (channel.original_score - basis) / Math.max(1, cost),
      exceptional_seeds: model.anchor.filter((anchor, seed) => panels[index].some(result => {
        const item = result?.metrics?.seed_results?.[seed]
        return acceptedCase(item) && (anchor.localBest === null ||
          model.direction * (item.score - anchor.localBest) > 0)
      })).length,
      legal_rate: mean(panels[index].map(result => Number(result?.metrics?.seed_results?.every(acceptedCase) ?? false))),
      tail_gap: channel.cvar,
      descendant_gain: histories[index].filter(event => oldIds.has(event.parent)).reduce((sum, event) =>
        sum + Math.max(0, event.reward ?? 0), 0),
      evaluation_wall_seconds: histories[index].reduce((sum, event) => sum + (event.elapsed_ms ?? 0) / 1000, 0),
    }
  })
  const [a, b] = metrics
  const winner = treatment.champion
  const passed = treatment.summary && control.summary && winner?.certified && winner.id !== old.id &&
    treatment.summary.best_id === winner.id && control.champion?.certified &&
    treatment.attempts > 0 && treatment.attempts === control.attempts &&
    b.original_gain > Math.max(0, a.original_gain) && b.gain_per_budget >= a.gain_per_budget &&
    b.legal_rate >= a.legal_rate && b.tail_gap <= a.tail_gap
  return { passed: Boolean(passed), metrics }
}

async function mergeChampion(files, treatment) {
  const { files: source, champion } = treatment
  const id = champion.id
  const row = (await source.read('population.jsonl')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).find(item => item.id === id)
  if (!row) throw new Error('DART trial champion is missing its population entry')
  const records = [`evals/${id}.json`]
  const evidenceFiles = new Map()
  for (const path of records) {
    const evidence = await readJson(source, path)
    if (!evidence) throw new Error(`DART trial champion is missing evidence: ${path}`)
    if (evidence.trace && !(await files.exists(evidence.trace))) {
      const trace = await source.read(evidence.trace)
      if (trace !== undefined) evidenceFiles.set(evidence.trace, trace)
      else delete evidence.trace
    }
    if (await files.exists(path)) throw new Error(`DART trial evidence already exists: ${path}`)
    evidenceFiles.set(path, JSON.stringify(evidence, null, 2) + '\n')
  }
  const candidate = `candidates/${id}`
  if (!/^candidates\/c[0-9]{6}$/.test(candidate) || await files.exists(candidate)) {
    throw new Error('DART trial champion has an invalid or already allocated candidate ID')
  }
  const population = await files.read('population.jsonl')
  const parent = await files.exists(`evals/${row.parent}.json`) ? row.parent : null
  const created = []
  // Preserve the trial lineage in its own branch and publish the champion last.
  try {
    created.push(candidate)
    await cp(candidatePath(source.root, id), files.resolve(candidate),
      { recursive: true, force: false, errorOnExist: true })
    for (const [path, contents] of evidenceFiles) {
      await files.write(path, contents)
      created.push(path)
    }
    const record = { ...row, parent, trial_parent: row.parent, survival: 'yes' }
    await files.write('population.jsonl', population + JSON.stringify(record) + '\n')
    await writeJson(files, CHAMPION, champion)
  } catch (error) {
    await files.write('population.jsonl', population)
    for (const path of created.reverse()) await files.remove(path)
    throw error
  }
}

export async function runStrategyTrial({ trial, args, files, run, rollback, activate }) {
  const old = await readJson(files, CHAMPION)
  const protocol = await readJson(files, 'dart/protocol.json')
  const model = await readJson(files, 'dart/model.json')
  const seedBudget = await readJson(files, SEED_BUDGET)
  const ledger = await readJson(files, BUDGET_FILE)
  const before = await budgetStatus(files.root, ledger.max)
  const seedAllowance = Math.floor((protocol.maxSeeds - seedBudget.used) / 2)
  const candidates = Math.min(3, args.candidates ?? 3, Math.floor(before.remaining / 2))
  const options = { ...args, dartTrial: true, candidates }
  let directory
  let control
  let treatment
  let passed = false
  let assessments
  let failure
  try {
    await rollback()
    if (old?.certified && candidates > 0 && seedAllowance >= protocol.seeds.length) {
      const base = files.resolve(TRIALS)
      await mkdir(base, { recursive: true })
      directory = await mkdtemp(join(base, 'trial-'))
      const common = { root: files.root, directory, args: options, run, before, seedBudget, seedAllowance }
      control = await runArm({ ...common, name: 'control' })
      if (!control.error) treatment = await runArm({ ...common, name: 'treatment', activate })
      failure = control.error ?? treatment?.error
      if (!failure && treatment) {
        const assessed = await comparison(control, treatment, old, model)
        passed = assessed.passed
        assessments = assessed.metrics
      }
    }
  } catch (error) {
    failure = error
  }
  const attempts = (control?.attempts ?? 0) + (treatment?.attempts ?? 0)
  const seedCalls = (control?.seedCalls ?? 0) + (treatment?.seedCalls ?? 0)
  if (passed) {
    try {
      await mergeChampion(files, treatment)
    } catch (error) {
      passed = false
      failure = error
    }
  }
  if (!passed && treatment) {
    try {
      await rollback()
    } catch (error) {
      failure = error
    }
  }
  if (attempts || seedCalls) {
    ledger.trial_attempts = (ledger.trial_attempts ?? 0) + attempts - Number(passed)
    seedBudget.used += seedCalls
    seedBudget.reservations.push({ count: seedCalls, purpose: 'paired strategy trial', at: new Date().toISOString() })
    await writeJson(files, BUDGET_FILE, ledger)
    await writeJson(files, SEED_BUDGET, seedBudget)
  }
  const decision = {
    package_id: trial.package, status: passed ? 'validated' : 'rolled_back',
    prior_champion: old?.id, observed_champion: treatment?.champion?.id,
    control_champion: control?.champion?.id, candidate_limit_per_arm: candidates, seed_limit_per_arm: seedAllowance,
    control: control && { attempts: control.attempts, seed_calls: control.seedCalls, fitness: control.champion?.fitness },
    treatment: treatment && { attempts: treatment.attempts, seed_calls: treatment.seedCalls, fitness: treatment.champion?.fitness },
    assessment: assessments && { control: assessments[0], treatment: assessments[1] },
    evidence_directory: directory,
    reason: failure?.message ?? (passed ? 'certified improvement over matched control' :
      treatment ? 'no certified improvement over matched control' : 'insufficient paired trial budget or uncertified baseline'),
  }
  await files.append('dart/strategy-trials.jsonl', JSON.stringify(decision) + '\n')
  if (failure) throw new Error(`DART strategy rolled back: ${failure.message}`, { cause: failure })
  const best = passed ? treatment.champion : old
  return { ...treatment?.summary, best_id: best?.id, best_fitness: best?.fitness,
    champion_certified: best?.certified, remaining: (await budgetStatus(files.root, ledger.max)).remaining,
    seed_remaining: protocol.maxSeeds - seedBudget.used, dart_trial: decision }
}
