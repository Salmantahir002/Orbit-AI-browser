/**
 * One requestAnimationFrame loop shared by every spring-driven glass surface.
 *
 * Each frame runs every task's `read` (layout measurements) before any task's
 * `write` (styles). With a loop per surface, one surface's write followed by
 * the next surface's read forced a synchronous style and layout pass per
 * surface per frame; batched, the browser lays out at most once.
 */
export type FrameTask = {
  read?: () => void
  /** Returns true to run again next frame. */
  write: (time: number) => boolean
}

const queued = new Set<FrameTask>()
let frame = 0

function run(time: number) {
  frame = 0
  const tasks = [...queued]
  queued.clear()
  for (const task of tasks) task.read?.()
  for (const task of tasks) {
    if (task.write(time)) queued.add(task)
  }
  if (queued.size && !frame) frame = requestAnimationFrame(run)
}

/** Runs the task next frame (once, unless its write asks for more). */
export function wakeFrameTask(task: FrameTask): void {
  queued.add(task)
  if (!frame) frame = requestAnimationFrame(run)
}

export function cancelFrameTask(task: FrameTask): void {
  queued.delete(task)
}
