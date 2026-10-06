import type { AgentSessionTaskRecord } from '../types/agentTypes'

/**
 * Session Memory — what earlier agent tasks in this app session did.
 *
 * Lets a follow-up goal ("now download it as .docx") build on the previous
 * task instead of starting blind and redoing it. Held in renderer memory only:
 * it is gone when the app closes, and never written to disk.
 *
 * Like Browser Memory, it stores only the agent's own structured record —
 * goals, statuses, the milestones the loop itself wrote — never page text.
 */

const MAX_TASKS = 5
const MAX_MILESTONES_PER_TASK = 12

class AgentSessionMemory {
  private tasks: AgentSessionTaskRecord[] = []

  record(task: AgentSessionTaskRecord): void {
    this.tasks.push({
      goal: task.goal.slice(0, 400),
      status: task.status,
      outcome: task.outcome.slice(0, 400),
      // "Do not type it again" guards the task that wrote it; carried into a
      // later task it would stop a deliberate re-run from writing anything.
      milestones: task.milestones
        .slice(-MAX_MILESTONES_PER_TASK)
        .map((milestone) => milestone.replace(/\s*Do not (?:type|enter) it again\.?$/, '')),
      finalUrl: task.finalUrl,
    })
    if (this.tasks.length > MAX_TASKS) this.tasks = this.tasks.slice(-MAX_TASKS)
  }

  history(): AgentSessionTaskRecord[] {
    return this.tasks.map((task) => ({ ...task, milestones: [...task.milestones] }))
  }

  clear(): void {
    this.tasks = []
  }
}

export const agentSessionMemory = new AgentSessionMemory()
