import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { filesOf } from '../files.js'
import { candidatePath } from '../candidates.js'
import { accepted, BASE, hash, protocolFor, readJson, taskConfig, usable, writeJson } from './store.js'
import { acceptedCase, calibrate, clamp, evaluateChannels, gain, mean, normalized, regression, utility, weightedOrder } from './model.js'
import { classify, clusterResponses, decomposition, difficultyRegistry, lineageWeights, seedProfiles } from './intelligence.js'
import { advisor, archives, chooseParent, complementary, mechanismMemory, sourcePatch, WORKERS } from './strategy.js'

const CHAMPION = 'dart/champion.json'
const MODEL = 'dart/model.json'
const EVENTS = 'dart/mutations.jsonl'
const REGISTRY = 'dart/difficulty-reference.json'
const PROTECTION = 'dart/protection.json'
const FORBIDDEN = /\b(?:OR_SEEDS|OR_TRACE_FILE|ALE_BENCH_SEED|seed_?id|instance_?hash|input_?sha256)\b/i

export async function beginDart(task, root, maxBudget) {
  const settings = await taskConfig(task).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!settings?.dart?.enabled) return undefined
  const protocol = await protocolFor(task, settings, maxBudget)
  const files = filesOf(root)
  const previous = await readJson(files, 'dart/protocol.json')
  if (previous && previous.version !== protocol.version) {
    throw new Error('DART V4 evaluation protocol differs from the saved run. Use a new task copy; the old run is preserved.')
  }
  if (!previous) await writeJson(files, 'dart/protocol.json', protocol)
  return { protocol, settings }
}

const candidateFor = (evolve, id) => ({ id, dir: candidatePath(evolve.currentRun().root, id) })
const recordFor = id => `evals/${id}.json`

async function evidence(evolve, candidate) {
  const { protocol, settings } = evolve.currentRun().dart
  const prior = await readJson(evolve.files, recordFor(candidate.id))
  const source = await readFile(join(candidate.dir, settings.program))
  if (prior?.protocol === protocol.version && prior.source_sha256 === hash([source]) &&
      usable(prior, protocol.seeds)) return prior
  await evolve.evaluate(candidate)
  const result = await readJson(evolve.files, recordFor(candidate.id))
  if (result?.protocol !== protocol.version || result.source_sha256 !== hash([source])) {
    throw new Error('DART evaluate providers must persist evaluation evidence for the current source and protocol.')
  }
  return result
}

export async function initializeDart(evolve) {
  const files = evolve.files
  const { protocol } = evolve.currentRun().dart
  const population = evolve.population()
  const rows = await population.rows()
  const candidate = rows.some(row => row.id === BASE) ? candidateFor(evolve, BASE) : await evolve.copyTask()
  const baseline = await evidence(evolve, candidate)
  if (!usable(baseline, protocol.seeds)) throw new Error('The initial program has no complete per-seed evidence.')
  if (!rows.some(row => row.id === BASE)) {
    await population.append({ id: BASE, parent: null, fitness: baseline.fitness, survival: 'yes' })
  }
  if (!(await files.exists(CHAMPION))) {
    await writeJson(files, CHAMPION, { id: BASE, fitness: baseline.fitness,
      certified: accepted(baseline, protocol.seeds) })
  }
  if (!(await files.exists(PROTECTION))) {
    await writeJson(files, PROTECTION, { id: BASE,
      established: baseline.metrics.seed_results.flatMap((item, index) => acceptedCase(item) ? [index] : []) })
  }
}

async function loadHistory(evolve, rows) {
  const { protocol, settings } = evolve.currentRun().dart
  const records = await Promise.all(rows.map(async row => {
    const result = await readJson(evolve.files, recordFor(row.id))
    const bytes = await readFile(join(candidateFor(evolve, row.id).dir, settings.program))
      .catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
    const code = bytes?.toString('utf8') ?? ''
    const raw = result?.metrics?.seed_results
    const match = bytes && result?.protocol === protocol.version && result.source_sha256 === hash([bytes])
    const problems = result?.metrics?.evaluation_failure ?? result?.metrics?.judge_result ??
      (result?.metrics?.error !== undefined ? 'EVALUATION_ERROR' : 'MISSING_EVIDENCE')
    const bySeed = new Map((match && Array.isArray(raw) ? raw : []).map(item => [item.seed, item]))
    return { ...row, fitness: match ? result.fitness : 0, code, source: match ? result.source_sha256 : undefined, result,
      safe: match && !FORBIDDEN.test(code), raw: protocol.seeds.map(seed => bySeed.get(seed) ??
        { seed, score: null, judge: match ? problems : 'MISSING_EVIDENCE' }) }
  }))
  records.sort((a, b) => a.id.localeCompare(b.id))
  return records
}

function eventMetrics(event, byId, model, hard) {
  const parent = byId.get(event.parent)
  const child = byId.get(event.id)
  if (!parent || !child) return { ...event, delta: model.anchor.map(() => null), reward: -1 }
  const delta = model.anchor.map((anchor, index) => gain(child.raw[index], parent.raw[index], anchor, model.direction))
  const cost = (event.seed_cost ?? 0) / model.anchor.length + Math.min((event.elapsed_ms ?? 0) / 60000, 1)
  const reward = child.channels.legal_rate ? clamp(utility(child, parent, model, hard) - 0.03 * cost, -1, 1) : -1
  return { ...event, delta, reward, normalizer: model.version }
}

export async function snapshot(evolve, rows = undefined) {
  rows ??= await evolve.population().rows()
  const files = evolve.files
  const { protocol, settings: { dart: settings } } = evolve.currentRun().dart
  const logged = (await files.read(EVENTS) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const entries = classify(await loadHistory(evolve, rows), logged)
  const baseline = entries.find(entry => entry.id === BASE)
  if (!baseline?.result) throw new Error('DART baseline evidence is missing')
  const reference = baseline.result.metrics.score_direction
  for (const entry of entries) {
    if (entry.result?.metrics?.score_direction !== reference) {
      entry.raw = entry.raw.map(item => acceptedCase(item) ? { seed: item.seed, score: null, judge: 'SCORE_DIRECTION_MISMATCH' } : item)
      entry.safe = false
    }
  }
  const history = entries.filter(entry => entry.safe && entry.raw.some(acceptedCase))
  const seen = new Set()
  const unique = history.filter(entry => {
    if (seen.has(entry.source)) return false
    seen.add(entry.source)
    return true
  })
  const weights = lineageWeights(unique)
  const version = hash(['dart-v4-gain', protocol.version, JSON.stringify(unique.map(entry => [entry.source,
    entry.raw.map(item => [item.score, item.judge])]))])
  const input = { baseline: baseline.result, history: unique, weights, settings, version }
  const fixedModel = calibrate(input)
  const model = await evolve.dartComponent('dart-calibrate', input)
  if (model?.direction !== fixedModel.direction || model.anchor?.length !== protocol.seeds.length ||
      model.anchor.some((item, index) => item.seed !== protocol.seeds[index] || !Number.isFinite(item.scale) || item.scale <= 0)) {
    throw new Error('DART evaluation components must provide a positive common scale for each seed')
  }
  const frozen = await readJson(files, REGISTRY)
  const registry = difficultyRegistry(history.length ? history : [baseline], weights, fixedModel, settings.quality_reference,
    frozen, settings.min_reference_programs, baseline)
  if (registry.frozen && registry !== frozen) {
    if (frozen) await writeJson(files, `dart/reference-history/${frozen.normalizer}.json`, frozen)
    await writeJson(files, REGISTRY, registry)
  }
  const protection = await readJson(files, PROTECTION)
  const hard = registry.cases.flatMap((item, index) => item.confidence >= 0.65 &&
    item.reference_difficulty !== null && item.reference_difficulty >= 0.65 ? [index] : [])
  const stable = protocol.seeds.flatMap((_, index) => acceptedCase(baseline.raw[index]) && history.length >= 4 &&
    mean(history.map(entry => Number(acceptedCase(entry.raw[index])))) >= 0.9 ? [index] : [])
  const easy = registry.cases.flatMap((item, index) => item.confidence >= 0.65 &&
    item.reference_difficulty !== null && item.reference_difficulty <= 0.35 ? [index] : [])
  const protectedCases = [...new Set([...protection.established, ...stable, ...easy])]
  const validVector = vector => Array.isArray(vector) && vector.length === protocol.seeds.length &&
    vector.every(value => value === null || Number.isFinite(value))
  for (const entry of entries) {
    entry.vector = await evolve.dartComponent('dart-normalize', { result: { metrics: { seed_results: entry.raw } }, model })
    if (!validVector(entry.vector)) throw new Error('DART normalize must return one finite value or null per seed')
    entry.channels = evaluateChannels(entry, fixedModel)
    entry.regression = regression(entry, baseline, fixedModel, protectedCases, settings)
    entry.robust = entry.channels.relative - 0.5 * entry.channels.cvar
  }
  const effects = await evolve.dartComponent('dart-decompose', { entries, model, registry, quality: settings.quality_reference })
  for (const [index, entry] of entries.entries()) entry.effects = effects[index]
  const current = await readJson(files, CHAMPION)
  const champion = entries.find(entry => entry.id === current.id)
  if (!champion) throw new Error('DART champion evidence is missing')
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const events = logged.map(event => eventMetrics(event, byId, fixedModel, hard))
  const mechanisms = mechanismMemory(events)
  const cases = seedProfiles({ incumbent: champion, entries, model, registry, events, protectedCases })
  const diagnostic = await evolve.dartComponent('dart-cluster', { entries, model, incumbent: champion, events })
  const archive = await evolve.dartComponent('dart-archive', { entries, groups: diagnostic.groups, cases, mechanisms })
  return { entries, byId, model, fixedModel, incumbent: champion, baseline, cases, registry, events, hard,
    archive, settings, mechanisms, ...diagnostic }
}

export async function dartParent(evolve, state = undefined) {
  state ??= await snapshot(evolve)
  const elite = new Set([state.incumbent.id, ...Object.values(state.archive).flat(3)])
  const entries = state.entries.filter(entry => (entry.survival === 'yes' || elite.has(entry.id)) &&
    entry.safe && (entry.id === state.incumbent.id || entry.channels.legal_rate > 0))
  const picked = await evolve.dartComponent('dart-parent', { ...state, entries })
  const decision = typeof picked === 'string' ? { id: picked, mode: 'custom' } : picked
  if (!entries.some(entry => entry.id === decision?.id)) throw new Error('DART parent must come from the eligible pool')
  state.selection = decision
  return decision.id
}

function armChoice({ recommendation = [], eligible, settings = {}, conflict = 0 }) {
  const weights = { ...Object.fromEntries(Object.entries(WORKERS).map(([name, item]) => [name, item.weight])),
    ...settings.worker_weights }
  return weightedOrder(eligible, arm => weights[arm] *
    (1 + 0.2 * clamp(recommendation.find(item => item.arm === arm)?.mean ?? 0, -1, 1)) *
    (arm === 'adaptive' || arm === 'transfer' ? 1 + conflict : 1))[0]
}

async function dispatch(evolve, state, selected) {
  const parent = state.byId.get(selected)
  if (!parent?.safe) throw new Error('DART dispatch requires an evaluated in-pool parent')
  const targetCase = weightedOrder(state.cases, item => item.priority)[0]
  const focus = state.groups.find(group => group.includes(targetCase.index)) ?? [targetCase.index]
  const conflicts = state.conflicts.filter(item => focus.includes(item.left) || focus.includes(item.right)).slice(0, 4)
  const donors = complementary(parent, state.entries, state.cases, state.fixedModel)
  const donor = state.selection?.donor ?? donors[0]?.id
  const { budget } = await evolve.context()
  const cohort = focus.map(index => state.cases[index])
  const context = [
    mean(cohort.map(item => item.gap)) >= 0.1 ? 'gap' : 'close',
    cohort.some(item => item.regression > 0.03) ? 'loss' : 'stable',
    mean(cohort.map(item => item.exposure)) < 3 ? 'underexplored' : 'observed',
    mean(cohort.map(item => item.search_difficulty)) > 0.65 ? 'stalled' : 'open',
    cohort.some(item => item.reference_difficulty !== null && item.confidence >= 0.65) ? 'known' : 'unknown',
    budget.remaining <= 5 ? 'low-budget' : 'budget',
  ].join('/')
  const recommendation = await evolve.dartComponent('dart-advisor', { events: state.events, context, cases: cohort, budget })
  const target = [...state.mechanisms].reverse().find(item => item.status === 'OBSERVED' &&
    !state.events.some(event => event.attribution_of === item.id && event.control_status === 'paired') &&
    state.byId.get(item.id)?.safe)
  const eligible = ['global', 'hard', 'repair', 'exploration']
  if (donor) eligible.push('transfer', 'adaptive')
  if (target) eligible.push('attribution')
  const allowed = eligible.filter(arm => (state.settings.worker_weights?.[arm] ?? WORKERS[arm].weight) > 0)
  const arm = await evolve.dartComponent('dart-arm', { events: state.events, context,
    eligible: allowed.length ? allowed : eligible, recommendation, settings: state.settings,
    conflict: Math.max(0, ...conflicts.map(item => item.weight * (item.controlled ? 2 : 1))) })
  if (!eligible.includes(arm)) throw new Error('DART dispatch selected an unavailable worker')
  const useDonor = arm === 'transfer' || arm === 'adaptive'
  let chosen = parent
  if (arm === 'attribution') chosen = state.byId.get(target.id)
  if (arm === 'repair') chosen = [...state.entries].filter(entry =>
    entry.safe && entry.channels.legal_rate === 1 && entry.regression.loss > 0.02)
    .sort((a, b) => b.channels.relative - a.channels.relative)[0] ?? parent
  const hints = state.mechanisms.filter(item => item.gains?.some((value, index) => focus.includes(index) && Math.abs(value ?? 0) >= 0.02))
    .sort((a, b) => Number(a.status === 'PAIRED') - Number(b.status === 'PAIRED')).slice(-6)
    .map(item => ({ tags: item.tags, status: item.status, expected_gain: mean(focus.map(index => item.gains[index] ?? 0)) }))
  const diagnostics = cohort.slice(0, 6).map(({ index, gap, reference_difficulty, difficulty_status, exposure, regression }) => ({
    gap, reference_difficulty, difficulty_status, exposure, regression, judge: chosen.raw[index].judge,
    seconds: chosen.raw[index].seconds, input_bytes: chosen.raw[index].input_bytes,
  }))
  const purpose = useDonor ? state.mechanisms.find(item => item.id === donor) : undefined
  const instruction = [
    'Read the task and edit only the solution between EVOLVE markers. Do not run benchmark evaluators.',
    'Never match instance identifiers, exact input fingerprints or leaderboard data. Use only task semantics and observable search state.',
    'Emit a short report including a line Mechanism: <one algorithmic intervention>.',
    arm === 'adaptive' ? 'Also describe Router:, Fallback:, and Budget: on separate lines.' : '',
    WORKERS[arm].task,
    `Target cohort: ${JSON.stringify(diagnostics)}. Protected cases: ${state.cases.filter(item => item.protected).length}.`,
    `Observed conflicts: ${JSON.stringify(conflicts.map(({ weight, controlled }) => ({ weight, controlled })))}. Prior mechanisms: ${JSON.stringify(hints)}.`,
    purpose ? `Donor mechanism: ${purpose.tags.join(', ')} (${purpose.status}). Donor changed near line ${purpose.patch.line}.` : '',
    arm === 'attribution' ? `Reverse intervention ${target.tags[0]} at line ${target.patch.line}. Original edit: ${JSON.stringify(target.patch).slice(0, 5000)}` : '',
  ].filter(Boolean).join('\n')
  return { parent: chosen.id, parent_mode: state.selection?.mode ?? 'custom', instruction, name: `dart-${arm}`, arm, context, focus,
    referenceIds: useDonor ? [donor] : arm === 'attribution' ? [target.parent] : [],
    attributionOf: arm === 'attribution' ? target.id : undefined }
}

async function consider(evolve, entry, state) {
  const { protocol } = evolve.currentRun().dart
  if (!entry.safe || !accepted(entry.result, protocol.seeds)) return false
  const current = await readJson(evolve.files, CHAMPION)
  if (!entry.regression.allowed) {
    await evolve.files.append('dart/promotions.jsonl', JSON.stringify({
      challenger: entry.id, incumbent: current.id, certified: false, reason: 'fixed long-term regression guard',
    }) + '\n')
    return false
  }
  const incumbent = state.incumbent
  if (current.certified && utility(entry, incumbent, state.fixedModel, state.hard) <= 0) return false
  if (await evolve.dartComponent('dart-promote', { entry, incumbent, model: state.fixedModel }) !== true) return false
  const certified = true
  await evolve.files.append('dart/promotions.jsonl', JSON.stringify({
    challenger: entry.id, incumbent: current.id, version: state.fixedModel.version,
    certified, original_score: entry.fitness, relative: entry.channels.relative, cvar: entry.channels.cvar,
  }) + '\n')
  if (certified) await writeJson(evolve.files, CHAMPION, { id: entry.id, fitness: entry.fitness, certified,
    source_sha256: entry.source, version: state.fixedModel.version })
  return certified
}

export async function dartStep(evolve) {
  const { protocol, settings } = evolve.currentRun().dart
  const files = evolve.files
  const population = evolve.population()
  const before = await readJson(files, 'dart/budget.json')
  if (protocol.maxSeeds - (before?.used ?? 0) < protocol.seeds.length) {
    throw Object.assign(new Error('DART seed evaluation budget exhausted'), { code: 'DART_BUDGET' })
  }
  const state = await snapshot(evolve)
  const parent = await evolve.select(population, state)
  const plan = await evolve.dartComponent('dart-dispatch', { state, selected: parent })
  if (!state.byId.get(plan.parent)?.safe || !Array.isArray(plan.focus) ||
      plan.focus.some(index => !Number.isInteger(index) || !state.cases[index])) {
    throw new Error('DART dispatch must select a known parent and focus indices inside the panel')
  }
  const candidate = await evolve.mutate(plan)
  const result = await evidence(evolve, candidate)
  const original = state.byId.get(plan.parent)
  const code = await readFile(join(candidate.dir, settings.program), 'utf8')
  const patch = sourcePatch(original.code, code)
  const intervention = state.events.find(event => event.id === plan.attributionOf)
  const exactReversion = intervention && state.byId.get(intervention.parent)?.code === code && original.code !== code
  const after = await readJson(files, 'dart/budget.json')
  await population.append({ id: candidate.id, parent: plan.parent, fitness: result.fitness,
    survival: 'yes', arm: plan.arm })
  const newEntry = { id: candidate.id, raw: protocol.seeds.map((seed, index) =>
    result.metrics?.seed_results?.[index] ?? { seed, score: null }), fitness: result.fitness }
  newEntry.channels = evaluateChannels(newEntry, state.fixedModel)
  newEntry.regression = regression(newEntry, state.baseline, state.fixedModel,
    state.cases.filter(item => item.protected).map(item => item.index), state.settings)
  const event = {
    id: candidate.id, parent: plan.parent, parent_mode: plan.parent_mode, arm: plan.arm,
    context: plan.context, focus: plan.focus, focus_seeds: plan.focus.map(index => state.cases[index].seed),
    router: plan.arm === 'adaptive' ? Object.fromEntries(['Router', 'Fallback', 'Budget'].flatMap(field => {
      const value = candidate.report?.split('\n').find(line => line.startsWith(field + ':'))?.slice(field.length + 1).trim()
      return value ? [[field.toLowerCase(), value]] : []
    })) : undefined,
    report: candidate.report, mechanism: candidate.report?.match(/(?:^|\n)Mechanism:\s*([^\n]+)/i)?.[1]?.trim(),
    source: result.source_sha256, parent_source: original.source, patch, attribution_of: plan.attributionOf,
    control_status: intervention ? exactReversion && newEntry.channels.legal_rate === 1 ? 'paired' : 'observed' : undefined,
    references: plan.referenceIds, seed_cost: after.used - before.used, elapsed_ms: result.cache_hit ? 0 : result.elapsed_ms,
  }
  const measured = eventMetrics(event, new Map([...state.byId, [candidate.id, newEntry]]), state.fixedModel, state.hard)
  await files.append(EVENTS, JSON.stringify(measured) + '\n')
  if ((await population.rows()).filter(row => row.survival === 'yes').length >= (await evolve.context()).maxPopulation) {
    await evolve.survive(population)
  }
}

async function chooseSubmission(evolve, state) {
  const selected = state.settings.submission_objective ?? (state.settings.scoring === 'relative' ? 'relative' : 'raw')
  const { protocol } = evolve.currentRun().dart
  const pool = [...new Set([...state.archive[selected], state.incumbent.id])].map(id => state.byId.get(id)).filter(Boolean)
  const ordered = await evolve.dartComponent('dart-submission-order', { pool, selected })
  if (!Array.isArray(ordered) || ordered.some(id => !pool.some(entry => entry.id === id))) {
    throw new Error('DART submission order must reference locally evaluated archive candidates')
  }
  for (const id of [...new Set([...ordered, ...pool.map(entry => entry.id)])]) {
    const entry = state.byId.get(id)
    if (!entry?.safe || !accepted(entry.result, protocol.seeds)) continue
    await writeJson(evolve.files, 'dart/submission.json', { id, objective: selected, source_sha256: entry.source,
      original_score: entry.fitness, local_relative: entry.channels.relative, tail_gap: entry.channels.cvar,
      validation: 'LEGAL' })
    return id
  }
  if (await evolve.files.exists('dart/submission.json')) await evolve.files.remove('dart/submission.json')
  return undefined
}

export async function finishDart(evolve, result, preTrialIds) {
  const files = evolve.files
  let state = await snapshot(evolve)
  if (!result?.seed_budget_exhausted && !result?.refresh_only) {
    const ranked = await Promise.all(state.entries.filter(entry => entry.id !== state.incumbent.id &&
      entry.channels.legal_rate === 1 && !preTrialIds?.has(entry.id)).map(async entry => ({
      entry, rank: await evolve.dartComponent('dart-rank', { entry, state }),
    })))
    for (const { entry } of ranked.sort((a, b) => b.rank - a.rank)) {
      try {
        if (await consider(evolve, entry, state)) {
          state = await snapshot(evolve)
          break
        }
      } catch (error) {
        if (error.code !== 'DART_BUDGET') throw error
        break
      }
    }
  }
  const submission = preTrialIds ? undefined : await chooseSubmission(evolve, state)
  await writeJson(files, MODEL, state.fixedModel)
  await writeJson(files, 'dart/archives.json', state.archive)
  await writeJson(files, 'dart/mechanisms.json', state.mechanisms)
  await writeJson(files, 'dart/diagnostics.json', {
    version: state.fixedModel.version, reference_frozen: state.registry.frozen,
    source_families: state.registry.cohorts, cases: state.cases, clusters: state.groups.map(group => group.map(index => state.cases[index].seed)),
    conflicts: state.conflicts, correlation: state.correlation, centered_correlation: state.centered_correlation,
    advice: await evolve.dartComponent('dart-advisor', { events: state.events, cases: state.cases }),
    programs: state.entries.map(({ id, family, source, effects, channels, regression: guard, raw }) => ({
      id, family, source, ...effects, original_score: channels.original_score, relative: channels.relative,
      cvar: channels.cvar, legal_rate: channels.legal_rate, protected: guard.allowed,
      judges: raw.map(item => item.judge),
    })),
  })
  const adaptive = state.events.filter(event => event.arm === 'adaptive').map(event => {
    const entry = state.byId.get(event.id)
    return { id: event.id, donor: event.references, router: event.router, gain: event.delta,
      code_changed: event.patch.added.length + event.patch.removed.length > 0,
      search_legal: entry?.channels.legal_rate === 1,
      documented: Boolean(event.router?.router && event.router?.fallback && event.router?.budget) }
  })
  await writeJson(files, 'dart/adaptive.json', adaptive)
  await writeJson(files, 'dart/responses.json', state.events.map(({ id, parent, delta, reward, normalizer }) =>
    ({ id, parent, delta, reward, normalizer })))
  const champion = await readJson(files, CHAMPION)
  const { budget } = await evolve.context()
  const seedBudget = await readJson(files, 'dart/budget.json')
  return { ...result, best_id: champion.id, best_fitness: champion.fitness, submission_id: submission,
    champion_certified: champion.certified, remaining: budget.remaining,
    seed_remaining: evolve.currentRun().dart.protocol.maxSeeds - seedBudget.used }
}

function submissionOrder({ pool, selected }) {
  const metric = selected === 'raw' ? entry => entry.channels.original_score :
    selected === 'relative' ? entry => entry.channels.relative : entry => entry.robust
  const ordered = [...pool].sort((a, b) => metric(b) - metric(a))
  const best = ordered[0] && metric(ordered[0])
  const margin = 0.001 * Math.abs(best ?? 0)
  const near = ordered.filter(entry => best - metric(entry) <= margin)
  near.sort((a, b) => a.channels.cvar - b.channels.cvar ||
    mean(a.raw.map(item => item.seconds ?? 0)) - mean(b.raw.map(item => item.seconds ?? 0)))
  const selectedIds = new Set(near.map(entry => entry.id))
  return [...near, ...ordered.filter(entry => !selectedIds.has(entry.id))].map(entry => entry.id)
}

export const DART_COMPONENTS = Object.freeze({
  'dart-calibrate': calibrate,
  'dart-normalize': ({ result, model }) => normalized(result, model),
  'dart-decompose': decomposition,
  'dart-cluster': ({ entries, model, events }) => clusterResponses(events, model.anchor.length),
  'dart-archive': archives,
  'dart-parent': input => chooseParent(input),
  'dart-advisor': ({ events, context }) => advisor(events, context),
  'dart-arm': armChoice,
  'dart-dispatch': ({ state, selected }, evolve) => dispatch(evolve, state, selected),
  'dart-rank': ({ entry }) => entry.robust,
  'dart-submission-order': submissionOrder,
  'dart-promote': () => true,
})

