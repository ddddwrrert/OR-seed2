import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { filesOf } from '../files.js'
import { candidatePath } from '../candidates.js'
import { evaluateResult } from '../providers/evaluate.js'
import { archive, calibrate, cvar, decomposition, fixedEasyFloor, guarded, lexicase, mean, normalized, profiles, utility } from './model.js'
import { accepted, BASE, BUDGETS, hash, PROBES, protocolFor, readJson, taskConfig, usable, writeJson } from './store.js'

const CHAMPION = 'dart/champion.json'
const MODEL = 'dart/model.json'
const ARMS = {
  repair: 'Improve the target failure mode and preserve the current general logic. Implement one intervention.',
  generalize: 'Improve the algorithm broadly. Explain the expected benefit and potential regressions in a short worker report.',
  synthesize: 'Combine complementary mechanisms from the reference solutions in one solver. Choose a branch using problem-semantic features or online search diagnostics observable within the normal solve workflow. Never infer or match seed IDs, input hashes, exact instance fingerprints, or benchmark-specific lookup tables. Preserve a feasible fallback and stay within one total solve budget.',
  ablate: 'Build the paired control. Disable only the intervention described in the target worker report, keeping the rest of the parent code and its budgets the same.',
}

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
    throw new Error('DART evaluation protocol changed. Start a separate task run to keep calibration and cache comparable.')
  }
  if (!previous) await writeJson(files, 'dart/protocol.json', protocol)
  return { protocol, settings }
}

const candidateFor = (evolve, id) => ({ id, dir: candidatePath(evolve.currentRun().root, id) })
const recordFor = (id, purpose, fraction = 1) => purpose === 'search' ? `evals/${id}.json` :
  `dart/evidence/${id}-${purpose}-${fraction}.json`

async function evidence(evolve, candidate, purpose, options = {}) {
  const prior = await readJson(evolve.files, recordFor(candidate.id, purpose, options.fraction))
  const { protocol, settings } = evolve.currentRun().dart
  const source = await readFile(join(candidate.dir, settings.program))
  if (prior?.protocol === protocol.version && prior.source_sha256 === hash([source]) &&
      usable(prior, options.seeds ?? protocol.seeds)) return prior
  if (purpose === 'search') {
    await evolve.evaluate(candidate)
    const result = await readJson(evolve.files, recordFor(candidate.id, purpose))
    if (result?.protocol !== evolve.currentRun().dart.protocol.version) {
      throw new Error('DART evaluate providers must persist protocol-matched per-seed evidence. Delegate to the default evaluate provider.')
    }
    return result
  }
  return await evaluateResult(candidate, evolve, { ...options, purpose })
}

export async function initializeDart(evolve) {
  const files = evolve.files
  const { protocol } = evolve.currentRun().dart
  const population = evolve.population()
  let rows = await population.rows()
  let baseline = await readJson(files, recordFor(BASE, 'search'))
  if (baseline?.protocol !== protocol.version || !usable(baseline, protocol.seeds)) {
    const candidate = rows.length ? candidateFor(evolve, BASE) : await evolve.copyTask()
    baseline = await evidence(evolve, candidate, 'search')
  }
  if (!usable(baseline, protocol.seeds)) {
    throw new Error('The public baseline has no complete ALE-Bench evidence. See run/evals/c000000.json.')
  }
  if (!rows.some(row => row.id === BASE)) {
    await population.append({ id: BASE, parent: null, fitness: baseline.fitness, survival: 'yes' })
    rows = await population.rows()
  }
  const validation = await evidence(evolve, candidateFor(evolve, BASE), 'validation', { seeds: protocol.validationSeeds })
  if (!usable(validation, protocol.validationSeeds) || validation.metrics.score_direction !== baseline.metrics.score_direction) {
    throw new Error('The validation baseline has no comparable ALE-Bench evidence.')
  }
  const current = await readJson(files, CHAMPION)
  const fixedModel = await readJson(files, MODEL)
  const incumbent = current?.id && current.id !== BASE && fixedModel
    ? await readJson(files, recordFor(current.id, 'search')) : undefined
  const violatesFloor = incumbent && (!accepted(incumbent, protocol.seeds) ||
    !fixedEasyFloor(incumbent.metrics.seed_results, baseline.metrics.seed_results, fixedModel))
  if (violatesFloor) {
    await files.append('dart/promotions.jsonl', JSON.stringify({
      incumbent: current.id, challenger: BASE, certified: false, reason: 'incumbent violated the fixed raw easy-case floor',
    }) + '\n')
  }
  if (!current || violatesFloor) {
    await writeJson(files, CHAMPION, { id: BASE, fitness: baseline.fitness, certified: accepted(baseline, protocol.seeds) && accepted(validation, protocol.validationSeeds) })
  }
}

// The panel is fixed in advance. Each recipe generates one frozen program and
// all budgets reuse its source. Neither the champion nor later mutations recalibrate it.
async function probeStep(evolve, probe) {
  const files = evolve.files
  const path = `dart/probes/${probe.name}.json`
  let pin = await readJson(files, path)
  if (!pin) {
    const { settings } = evolve.currentRun().dart
    const authored = settings.dart.probe_programs?.[probe.name]
    let generated
    if (authored) {
      generated = await evolve.allocate(BASE)
      await copyFile(join(evolve.currentRun().task, 'evaluator', authored), join(generated.dir, settings.program))
    } else generated = await evolve.mutate({
      parent: BASE,
      name: `probe-${probe.name}`,
      instruction: 'Read the statement. Edit only the solution between the EVOLVE markers. Do not run benchmarks. ' +
        probe.instruction + ' Aim to return a valid solution within half of the official time limit. Never branch on seed IDs or input fingerprints.',
    })
    const source = await readFile(join(generated.dir, settings.program))
    pin = { id: generated.id, recipe: probe.name, authored, source_sha256: hash([source]) }
    await writeJson(files, path, pin)
  }
  const candidate = candidateFor(evolve, pin.id)
  const source = await readFile(join(candidate.dir, evolve.currentRun().dart.settings.program))
  if (hash([source]) !== pin.source_sha256) throw new Error(`Pinned DART probe changed: ${pin.id}`)
  for (const fraction of BUDGETS) {
    await evidence(evolve, candidate, fraction === 1 ? 'search' : 'probe', { fraction })
  }
  const population = evolve.population()
  if (!(await population.rows()).some(row => row.id === pin.id)) {
    const result = await readJson(files, recordFor(pin.id, 'search'))
    await population.append({ id: pin.id, parent: BASE, fitness: result.fitness, survival: 'yes', probe: probe.name })
  }
}

async function ensureModel(evolve, exploratoryProvider) {
  const files = evolve.files
  const { protocol, settings } = evolve.currentRun().dart
  const baseline = await readJson(files, recordFor(BASE, 'search'))
  const probeIds = await Promise.all(PROBES.map(probe => readJson(files, `dart/probes/${probe.name}.json`)))
  const results = []
  for (const probe of probeIds.filter(Boolean)) {
    for (const fraction of BUDGETS) {
      const observation = await readJson(files, recordFor(probe.id, fraction === 1 ? 'search' : 'probe', fraction))
      if (observation?.protocol === protocol.version && observation.source_sha256 === probe.source_sha256 &&
          usable(observation, protocol.seeds) && observation.metrics.budget_fraction === fraction &&
          observation.metrics.score_direction === baseline.metrics.score_direction) {
        results.push(observation)
      }
    }
  }
  const complete = probeIds.every(Boolean) && results.length === PROBES.length * BUDGETS.length
  const configured = Boolean(settings.dart.probe_programs?.greedy)
  const finished = probeIds.every(Boolean) && (await evolve.population().rows()).filter(row => row.probe).length === PROBES.length
  if (configured && finished && (!complete || results.some(result => result.metrics.budget_fraction === 1 &&
      !result.metrics.seed_results.some(seed => seed.judge === 'ACCEPTED')))) {
    throw new Error('DART fixed calibration requires complete paired observations and accepted full-budget runs')
  }
  const version = hash(['dual-anchor-v2', protocol.version, JSON.stringify([baseline, ...results].map(result => ({
    source: result.source_sha256, budget: result.metrics.budget_fraction,
    scores: result.metrics.seed_results.map(item => [item.seed, item.score, item.judge]),
  })))])
  const input = { baseline, probes: results, version }
  const model = exploratoryProvider ? await evolve.dartComponent('dart-calibrate', input) :
    await evolve.dartComponent('dart-calibrate', input, { defaultProvider: true })
  const anchorsValid = model?.anchor?.length === protocol.seeds.length &&
    model.anchor.every((item, index) => item.seed === protocol.seeds[index] &&
      Number.isFinite(item.low) && Number.isFinite(item.scale) && item.scale > 0)
  const casesValid = model?.cases?.length === protocol.seeds.length &&
    model.cases.every((item, index) => item.seed === protocol.seeds[index] &&
      item.index === index && Number.isFinite(item.difficulty))
  if (!anchorsValid || !casesValid || model.direction !== (baseline.metrics.score_direction === 'maximize' ? 1 : -1)) {
    throw new Error('DART calibration must return finite anchors and indexed difficulties for the current panel')
  }
  const calibrated = { ...model, version: exploratoryProvider ? hash([version, exploratoryProvider, JSON.stringify(model)]) : version,
    calibration_status: complete && configured ? 'fixed' : complete ? 'generated' : 'degraded',
    panel: probeIds.filter(Boolean) }
  if (!exploratoryProvider) await writeJson(files, MODEL, calibrated)
  return calibrated
}

export async function snapshot(evolve, rows = undefined) {
  rows ??= await evolve.population().rows()
  const files = evolve.files
  const fixedModel = await readJson(files, MODEL)
  const calibration = evolve.getProvider('dart-calibrate')
  const model = calibration.run === DART_COMPONENTS['dart-calibrate']
    ? fixedModel : await ensureModel(evolve, calibration.name || 'custom')
  const champion = await readJson(files, CHAMPION)
  const { protocol } = evolve.currentRun().dart
  const direction = model.direction === 1 ? 'maximize' : 'minimize'
  const entries = (await Promise.all(rows.map(async row => {
    const result = await readJson(files, recordFor(row.id, 'search'))
    if (result?.protocol !== protocol.version || !usable(result, protocol.seeds) ||
        result.metrics.score_direction !== direction) return undefined
    const vector = await evolve.dartComponent('dart-normalize', { result, model })
    if (!Array.isArray(vector) || vector.length !== protocol.seeds.length || !vector.every(Number.isFinite)) {
      throw new Error('DART normalization must return one finite value per seed')
    }
    const effects = await evolve.dartComponent('dart-decompose', { vector, model })
    return { ...row, vector, effects, raw: result.metrics.seed_results,
      source: result.source_sha256 }
  }))).filter(Boolean)
  const incumbent = entries.find(entry => entry.id === champion.id)
  if (!incumbent) throw new Error('DART champion evidence is missing or incompatible')
  const diagnostic = await evolve.dartComponent('dart-cluster', { entries, model, incumbent })
  const experts = await evolve.dartComponent('dart-archive', {
    entries: entries.filter(entry => entry.raw.some(item => item.judge === 'ACCEPTED')),
    groups: diagnostic.groups,
  })
  return { entries, model, fixedModel, incumbent, ...diagnostic, experts }
}

export async function dartParent(evolve, state) {
  const { entries, incumbent, cases, experts } = state ?? await snapshot(evolve)
  const elite = new Set([incumbent.id, ...experts.flat()])
  const eligible = entries.filter(entry => (entry.survival === 'yes' || elite.has(entry.id)) &&
    (entry.id === incumbent.id || entry.raw.some(item => item.judge === 'ACCEPTED')))
  const parent = await evolve.dartComponent('dart-parent', { entries: eligible, cases })
  if (!eligible.some(entry => entry.id === parent)) throw new Error('DART parent must come from the eligible pool')
  return parent
}

function armChoice(events, context, eligible) {
  const observations = events.filter(event => event.context === context && Number.isFinite(event.reward))
  return [...eligible].sort((a, b) => {
    const score = arm => {
      const rewards = observations.filter(event => event.arm === arm).map(event => event.reward)
      return rewards.length ? mean(rewards) + Math.sqrt(2 * Math.log(observations.length + 1) / rewards.length) : Infinity
    }
    const left = score(a)
    const right = score(b)
    return left === right ? 0 : right - left
  })[0]
}

async function dispatch(evolve, state, selected) {
  const files = evolve.files
  const events = (await files.read('dart/mutations.jsonl') ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const groups = [...state.groups].sort((a, b) =>
    mean(b.map(index => state.cases[index].gap)) - mean(a.map(index => state.cases[index].gap)))
  const focus = groups[0]
  const ranked = focus.map(index => state.cases[index]).sort((a, b) => b.gap - a.gap)
  const context = mean(focus.map(index => state.cases[index].gap)) > 0.1 ? 'large-gap' : 'small-gap'
  const selectedEntry = state.entries.find(entry => entry.id === selected) ?? state.incumbent
  const entries = new Map(state.entries.map(entry => [entry.id, entry]))
  const references = [...new Set(state.experts.flatMap(([id], cluster) => {
    const expert = entries.get(id)
    const indices = state.groups[cluster]
    if (!expert || id === selected) return []
    const advantage = mean(indices.map(index => expert.vector[index] - selectedEntry.vector[index]))
    return advantage > 0 ? [id] : []
  }))].slice(0, 3)
  const completed = new Set(events.filter(event => event.arm === 'ablate').map(event => event.ablationOf))
  const target = [...events].reverse().find(event => event.arm !== 'ablate' && event.reward > 0 &&
    event.report && !completed.has(event.id))
  const eligible = ['repair', 'generalize']
  if (references.length) eligible.push('synthesize')
  if (target) eligible.push('ablate')
  const arm = await evolve.dartComponent('dart-arm', { events, context, eligible })
  if (!eligible.includes(arm)) throw new Error('DART dispatch selected an unavailable action')
  const parent = arm === 'ablate' ? target.id : selected
  const parentEntry = state.entries.find(entry => entry.id === parent) ?? state.incumbent
  const timeouts = parentEntry.raw.filter(item => item.judge === 'TIME_LIMIT_EXCEEDED').length
  const diagnostics = ranked.slice(0, 4).map(({ index, difficulty, gap }) => {
    const item = parentEntry.raw[index]
    return { difficulty, gap, status: item.judge, seconds: item.seconds, input_bytes: item.input_bytes }
  })
  const instruction = [
    'Read the problem and edit only the solution between EVOLVE markers. Do not run benchmark evaluators.',
    'Protect general performance and easy cases. Use only problem semantics or online diagnostics to adapt. Never match seeds, hashes or exact input fingerprints.',
    'Emit one short text report describing the intervention and the expected effect.',
    `Parent timeouts: ${timeouts}. Target cohort summaries: ${JSON.stringify(diagnostics)}`,
    ARMS[arm],
    arm === 'ablate' ? `Intervention to disable: ${target.report}` : '',
  ].filter(Boolean).join('\n')
  return { parent, instruction, name: `dart-${arm}`, arm, context, focus,
    referenceIds: arm === 'synthesize' ? references : [], ablationOf: arm === 'ablate' ? target.id : undefined }
}

function validationGuard(candidate, incumbent, baseline, direction) {
  const raw = result => result.metrics.seed_results
  const delta = raw(candidate).map((item, index) => {
    const fixed = raw(baseline)[index]
    const reference = raw(incumbent)[index]
    if (reference.judge !== 'ACCEPTED') return 0
    const change = direction * (item.score - reference.score)
    if (fixed.score !== 0) return change / Math.abs(fixed.score)
    // A zero baseline supplies no relative scale. Require no loss for that seed.
    return change < 0 ? -Infinity : 0
  })
  return delta.every(Number.isFinite) && mean(delta) >= -0.005 && cvar(delta) >= -0.05
}

async function consider(evolve, id, state) {
  const files = evolve.files
  const { protocol, settings } = evolve.currentRun().dart
  const result = await readJson(files, recordFor(id, 'search'))
  if (result?.protocol !== protocol.version || !accepted(result, protocol.seeds) ||
      result.metrics.score_direction !== (state.model.direction === 1 ? 'maximize' : 'minimize')) return
  const challengerSource = await readFile(join(candidateFor(evolve, id).dir, settings.program))
  if (result.source_sha256 !== hash([challengerSource])) return
  // The program never receives a seed ID. Block explicit harness or seed-ID
  // dispatch hooks if a worker introduces them in a proposed solver.
  const forbidden = /\b(?:OR_SEEDS|OR_TRACE_FILE|ALE_BENCH_SEED|seed_?id|instance_?hash|input_?sha256)\b/i
  if (forbidden.test(challengerSource.toString())) return
  const fixed = state.fixedModel
  const baselineResult = await readJson(files, recordFor(BASE, 'search'))
  if (!fixedEasyFloor(result.metrics.seed_results, baselineResult.metrics.seed_results, fixed)) {
    await files.append('dart/promotions.jsonl', JSON.stringify({
      challenger: id, incumbent: state.incumbent.id, certified: false, reason: 'fixed raw easy-case floor',
    }) + '\n')
    return
  }
  const vector = normalized(result, fixed)
  const incumbentVector = normalized(await readJson(files, recordFor(state.incumbent.id, 'search')), fixed)
  const current = await readJson(files, CHAMPION)
  if (current.certified && !(utility(vector) > utility(incumbentVector) &&
    result.fitness > state.incumbent.fitness)) return
  if (!guarded(vector, incumbentVector, fixed)) return
  if (await evolve.dartComponent('dart-promote', { id, vector, incumbent: incumbentVector, model: fixed }) !== true) return
  const validation = { seeds: protocol.validationSeeds }
  const baseline = await evidence(evolve, candidateFor(evolve, BASE), 'validation', validation)
  const incumbent = await evidence(evolve, candidateFor(evolve, current.id), 'validation', validation)
  const challenger = await evidence(evolve, candidateFor(evolve, id), 'validation', validation)
  const certified = accepted(challenger, protocol.validationSeeds) &&
    challenger.metrics.score_direction === result.metrics.score_direction &&
    validationGuard(challenger, incumbent, baseline, state.model.direction) &&
    validationGuard(challenger, baseline, baseline, state.model.direction)
  await files.append('dart/promotions.jsonl', JSON.stringify({
    challenger: id, incumbent: current.id, version: fixed.version,
    certified, public_fitness: result.fitness, normalized_mean: mean(vector), cvar: cvar(vector),
  }) + '\n')
  if (certified) await writeJson(files, CHAMPION, { id, fitness: result.fitness, certified, version: fixed.version })
}

async function modelOrBuild(evolve) {
  return await readJson(evolve.files, MODEL) ?? await ensureModel(evolve)
}

export async function dartStep(evolve) {
  const files = evolve.files
  const population = evolve.population()
  const available = (await evolve.context()).budget
  const { protocol } = evolve.currentRun().dart
  const seedBudget = await readJson(files, 'dart/budget.json')
  if (protocol.maxSeeds - (seedBudget?.used ?? 0) < protocol.seeds.length) {
    throw Object.assign(new Error('DART seed evaluation budget exhausted'), { code: 'DART_BUDGET' })
  }
  const { settings } = evolve.currentRun().dart
  const hasPanel = settings.dart.probe_programs?.greedy || settings.dart.allow_generated_probes
  if (hasPanel && !(await files.exists(MODEL)) && available.max >= PROBES.length + 1) {
    for (const probe of PROBES) {
      const pin = await readJson(files, `dart/probes/${probe.name}.json`)
      if (!pin || !(await population.rows()).some(row => row.id === pin.id)) {
        await probeStep(evolve, probe)
        return
      }
    }
  }
  await modelOrBuild(evolve)
  const state = await snapshot(evolve)
  const parent = await evolve.select(population)
  const dispatched = await evolve.dartComponent('dart-dispatch', { state, selected: parent })
  const plan = {
    ...dispatched,
    instruction: dispatched.instruction + '\nAdapt only to problem semantics or online diagnostics. Never match seed IDs, exact instance fingerprints, or benchmark lookup tables.',
  }
  const candidate = await evolve.mutate(plan)
  const result = await evidence(evolve, candidate, 'search')
  await population.append({ id: candidate.id, parent: plan.parent, fitness: result.fitness, survival: 'yes', arm: plan.arm })
  const original = state.entries.find(entry => entry.id === plan.parent)
  const vector = usable(result, protocol.seeds) && result.metrics.score_direction === (state.model.direction === 1 ? 'maximize' : 'minimize')
    ? await evolve.dartComponent('dart-normalize', { result, model: state.model }) : undefined
  if (vector && (!Array.isArray(vector) || vector.length !== protocol.seeds.length || !vector.every(Number.isFinite))) {
    throw new Error('DART normalization must return one finite value per seed')
  }
  const delta = original && vector ? vector.map((value, index) => value - original.vector[index]) : undefined
  const reward = delta ? Math.max(-1, Math.min(1, 0.7 * mean(plan.focus.map(index => delta[index])) + 0.3 * cvar(delta))) : -1
  const changedSource = original?.source && result.source_sha256 && original.source !== result.source_sha256
  const pairedEffect = plan.ablationOf && changedSource && candidate.report && delta
  const event = {
    id: candidate.id, parent: plan.parent, arm: plan.arm, context: plan.context, focus: plan.focus,
    report: candidate.report, source: result.source_sha256, parent_source: original?.source, delta, reward: plan.arm === 'ablate' ? (pairedEffect ? Math.abs(reward) : -1) : reward,
    ablationOf: plan.ablationOf, references: plan.referenceIds,
    control_status: plan.ablationOf ? (pairedEffect ? 'observed' : 'unverified') : undefined,
    intervention_effect: pairedEffect ? delta.map(value => -value) : undefined,
  }
  await files.append('dart/mutations.jsonl', JSON.stringify(event) + '\n')
  if ((await population.rows()).filter(row => row.survival === 'yes').length >= (await evolve.context()).maxPopulation) {
    await evolve.survive(population)
  }
}

export async function finishDart(evolve, result, preTrialIds) {
  const files = evolve.files
  if (!(await files.exists(CHAMPION))) throw new Error('DART baseline initialization did not finish')
  const rows = await evolve.population().rows()
  let state
  if (await files.exists(MODEL) || rows.filter(row => row.probe).length === PROBES.length ||
      (await evolve.context()).budget.remaining === 0) {
    await modelOrBuild(evolve)
    state = await snapshot(evolve, rows)
    if (!result?.seed_budget_exhausted) {
      const ranked = await Promise.all(state.entries.map(async entry => ({
        entry, priority: await evolve.dartComponent('dart-rank', { entry, state }),
      })))
      const ordered = ranked.sort((a, b) => b.priority - a.priority).map(item => item.entry)
      for (const entry of ordered) {
        try {
          if (entry.id !== state.incumbent.id && !preTrialIds?.has(entry.id)) await consider(evolve, entry.id, state)
        } catch (error) {
          if (error.code !== 'DART_BUDGET') throw error
          break
        }
        if ((await readJson(files, CHAMPION)).id !== state.incumbent.id) {
          state = await snapshot(evolve, rows)
          break
        }
      }
    }
    await writeJson(files, 'dart/diagnostics.json', {
      version: state.model.version, calibration_status: state.model.calibration_status, cases: state.cases,
      clusters: state.groups.map(group => group.map(index => state.cases[index].seed)),
      experts: state.experts,
      programs: state.entries.map(({ id, effects, vector }) => ({ id, ...effects, mean: mean(vector), cvar: cvar(vector) })),
    })
  }
  const champion = await readJson(files, CHAMPION)
  const { budget } = await evolve.context()
  const seedBudget = await readJson(files, 'dart/budget.json')
  const seedRemaining = evolve.currentRun().dart.protocol.maxSeeds - (seedBudget?.used ?? 0)
  return { ...result, best_id: champion.id, best_fitness: champion.fitness, remaining: budget.remaining,
    champion_certified: champion.certified, seed_remaining: seedRemaining }
}


export const DART_COMPONENTS = Object.freeze({
  'dart-calibrate': ({ baseline, probes, version }) => calibrate(baseline, probes, version),
  'dart-normalize': ({ result, model }) => normalized(result, model),
  'dart-decompose': ({ vector, model }) => decomposition(vector, model),
  'dart-cluster': ({ entries, model, incumbent }) => profiles(entries, model, incumbent.vector),
  'dart-archive': ({ entries, groups }) => archive(entries, groups),
  'dart-parent': ({ entries, cases }) => lexicase(entries, cases),
  'dart-arm': ({ events, context, eligible }) => armChoice(events, context, eligible),
  'dart-dispatch': ({ state, selected }, evolve) => dispatch(evolve, state, selected),
  'dart-rank': ({ entry }) => utility(entry.vector),
  'dart-promote': () => true,
})
