/**
 * Default mutate / variation provider: allocates candidate directory and spawns a worker subagent.
 * Accepts per-worker instruction, name, persona, model, and tool settings.
 *
 * @module dsh-evolve-loop/providers/mutate
 */

import { cp, mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { candidatePath, isCandidate } from '../candidates.js'

export const name = 'candidate-builder'

/** Default worker persona. */
export function defaultPersona() {
  return 'You are a solution worker in an evolutionary search. Design and implement one complete candidate in your assigned directory. IMPLEMENT A SINGLE SOLUTION. DO NOT ATTEMPT MULTIPLE SOLUTIONS.'
}

/**
 * Default worker task instruction with parent fitness feedback.
 * @param {number} [parentFitness] - fitness score of the parent solution.
 * @returns {string}
 */
export function defaultInstruction(parentFitness) {
  const lines = [
    'Read the task statement and the parent solution in this directory.',
  ]

  if (typeof parentFitness === 'number' && Number.isFinite(parentFitness)) {
    lines.push(`The parent candidate's official fitness was ${parentFitness}.`)
  }

  lines.push(
    'Understand how the current solution works, consider how it could better satisfy the task, and implement your chosen improvement as one complete candidate.',
    'Edit only the solution code between the #EVOLVE_START and #EVOLVE_END markers; leave all other task files and code unchanged.',
    'This directory is one allocated candidate and one complete solution attempt. You may reason about alternatives, but do not write, run, or compare several complete implementations here. A different complete attempt requires another candidate and uses another budget unit.',
    'Do not run the task\'s official evaluator or performance benchmarks; the search loop evaluates your candidate after you finish.',
  )

  return lines.join('\n')
}

/**
 * Produce a mutated candidate from a parent.
 * @param {object} options - configuration options.
 * @param {string} options.parent - parent candidate id (required).
 * @param {number} [options.parentFitness] - fitness score of the parent candidate.
 * @param {string} [options.instruction] - task instruction for the worker subagent.
 * @param {string} [options.name='mutator'] - worker name shown in subagent listings.
 * @param {string} [options.description] - existing worker label option, used when name is omitted.
 * @param {string} [options.persona] - persona instructions for the worker subagent.
 * @param {string} [options.model] - model id override for the worker.
 * @param {boolean} [options.allowShell=true] - whether shell tools are available to the worker. On by default.
 * @param {string[]} [options.allowedTools] - additional tool names granted to the worker.
 * @param {number} [options.maxDepth] - max delegation depth.
 * @param {object} evolve - the evolve service.
 * @returns {Promise<{ id: string, dir: string }>} the allocated candidate.
 */
export async function mutate(options, evolve) {
  const {
    parent,
    parentFitness: providedFitness,
    instruction: providedInstruction,
    name: workerName,
    description,
    persona = defaultPersona(),
    model,
    allowShell = true,
    allowedTools,
    maxDepth,
    referenceIds = [],
    arm: _arm,
    context: _context,
    focus: _focus,
    attributionOf: _attributionOf,
    parent_mode: _parentMode,
    ...extra
  } = options ?? {}

  if (!parent) throw new Error('mutate needs a parent candidate id')

  let parentFitness = providedFitness
  if (parentFitness === undefined && evolve?.population) {
    const rows = await evolve.population().rows()
    const parentRow = rows.find(r => r.id === parent)
    if (parentRow && typeof parentRow.fitness === 'number') {
      parentFitness = parentRow.fitness
    }
  }

  const instruction = providedInstruction ?? defaultInstruction(parentFitness)
  const candidate = await evolve.allocate(parent)
  const workerLabel = workerName ?? description ?? 'mutator'

  let report
  let references
  if (referenceIds.length) {
    const { root, dart } = evolve.currentRun()
    const program = dart.settings.program
    references = join(candidate.dir, '.dart-references')
    await mkdir(references)
    try {
      for (const [index, id] of referenceIds.entries()) {
        if (!(await isCandidate(root, id))) throw new Error('Invalid DART expert reference')
        await cp(join(candidatePath(root, id), program), join(references, `${index}-${basename(program)}`))
      }
    } catch (error) {
      await rm(references, { recursive: true, force: true })
      throw error
    }
  }
  try {
    const response = await evolve.spawnWorker(candidate.dir, references ?
      instruction + '\nRead .dart-references/ for complementary solution code. Leave those files untouched.' : instruction, {
      label: workerLabel,
      persona,
      model,
      allowShell,
      allowedTools,
      maxDepth,
      ...extra,
    })
    report = response?.text?.slice(0, 2000)
  } catch (error) {
    // If the run was canceled, rethrow to unwind immediately.
    const currentRun = evolve.currentRun?.()
    if (currentRun?.signal?.aborted) throw error
    // A failed worker leaves candidate files as is; it will still be evaluated.
  } finally {
    if (references) await rm(references, { recursive: true, force: true })
  }

  return report && evolve.currentRun?.().dart ? { ...candidate, report } : candidate
}

export default { name, mutate, defaultInstruction, defaultPersona }
