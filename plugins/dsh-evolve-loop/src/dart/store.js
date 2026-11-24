import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const BASE = 'c000000'
export const DEFAULT_SEEDS = Array.from({ length: 50 }, (_, seed) => seed)
export const PROBES = [
  { name: 'greedy', instruction: 'Implement a deterministic construction with a different ordering or tie-breaking heuristic. Keep effort low.' },
  { name: 'multistart', instruction: 'Implement a bounded multi-start or randomized construction, with a fast feasible incumbent and an early stop.' },
  { name: 'refinement', instruction: 'Implement an incremental local improvement or lookahead method with a fast feasible fallback.' },
]
export const BUDGETS = [0.5, 1]

export async function readJson(files, path) {
  const value = await files.read(path)
  return value === undefined ? undefined : JSON.parse(value)
}

export async function writeJson(files, path, value) {
  await files.write(path, JSON.stringify(value, null, 2) + '\n')
}

export function hash(parts) {
  const digest = createHash('sha256')
  for (const part of parts) {
    const bytes = Buffer.from(part)
    digest.update(String(bytes.length)).update(':').update(bytes)
  }
  return digest.digest('hex')
}

async function evaluatorFiles(dir) {
  const parts = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '__pycache__') continue
    const path = join(dir, entry.name)
    parts.push(entry.name)
    if (entry.isDirectory()) parts.push(...await evaluatorFiles(path))
    else if (entry.isFile()) parts.push(await readFile(path))
    else throw new Error('DART evaluator directories must contain regular files')
  }
  return parts
}

export async function taskConfig(task) {
  return JSON.parse(await readFile(join(task, 'task.json'), 'utf8'))
}

export async function protocolFor(task, settings, maxBudget) {
  const programs = settings.dart.probe_programs ?? {}
  const recipeCount = Object.keys(programs).length
  if ((recipeCount !== 0 && recipeCount !== PROBES.length) ||
      new Set(Object.values(programs)).size !== recipeCount ||
      !Object.entries(programs).every(([name, file]) => PROBES.some(probe => probe.name === name) &&
        typeof file === 'string' && /^[a-zA-Z0-9_.-]+\.cpp$/.test(file))) {
    throw new Error('DART probe_programs must map all three recipes to distinct .cpp files inside evaluator/')
  }
  if (recipeCount) {
    const sources = await Promise.all(Object.values(programs).map(async program => {
      try {
        return hash([await readFile(join(task, 'evaluator', program))])
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        throw new Error(`DART fixed probe is missing: ${program}`, { cause: error })
      }
    }))
    if (new Set(sources).size !== recipeCount) throw new Error('DART fixed probes must have distinct source')
  }
  const seeds = settings.dart.seeds ?? DEFAULT_SEEDS
  const validationSeeds = settings.dart.validation_seeds ?? [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]
  const allSeeds = [...seeds, ...validationSeeds]
  if (!seeds.length || !validationSeeds.length || new Set(allSeeds).size !== allSeeds.length ||
      !allSeeds.every(seed => Number.isSafeInteger(seed) && seed >= 0)) {
    throw new Error('DART requires distinct, disjoint search and validation seed lists')
  }
  const maxSeeds = settings.dart.max_seed_calls ??
    (1 + maxBudget + PROBES.length + 1) * (seeds.length + validationSeeds.length)
  if (!Number.isSafeInteger(maxSeeds) || maxSeeds < seeds.length + validationSeeds.length) {
    throw new Error('DART max_seed_calls must cover both panels for the baseline')
  }
  const version = hash([
    'dart-evaluator-v2', JSON.stringify(settings), JSON.stringify({ seeds, validationSeeds, maxSeeds }),
    ...await evaluatorFiles(join(task, 'evaluator')),
  ])
  return { seeds, validationSeeds, maxSeeds, version }
}

export async function reserve(evolve, count, purpose) {
  const files = evolve.files
  const { maxSeeds } = evolve.currentRun().dart.protocol
  const budget = await readJson(files, 'dart/budget.json') ?? { used: 0, reservations: [] }
  if (budget.used + count > maxSeeds) {
    throw Object.assign(new Error('DART seed evaluation budget exhausted'), { code: 'DART_BUDGET' })
  }
  budget.used += count
  budget.reservations.push({ count, purpose, at: new Date().toISOString() })
  await writeJson(files, 'dart/budget.json', budget)
}

export function usable(result, seeds) {
  const cases = result?.metrics?.seed_results
  return Array.isArray(cases) && cases.length === seeds.length &&
    ['maximize', 'minimize'].includes(result.metrics.score_direction) &&
    cases.every((item, index) => item.seed === seeds[index] &&
      Number.isFinite(item.score) && typeof item.judge === 'string' && item.judge !== 'INTERNAL_ERROR')
}

export function accepted(result, seeds) {
  return usable(result, seeds) && result.metrics.seed_results.every(item => item.judge === 'ACCEPTED')
}

