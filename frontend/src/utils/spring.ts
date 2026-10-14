/**
 * A damped spring, the physics behind the glass surfaces' motion: a value is
 * pulled toward its target and keeps its momentum, so it overshoots and
 * settles the way a drop of liquid does instead of easing to a stop.
 */
export type Spring = { value: number; velocity: number; target: number }

export function spring(value: number): Spring {
  return { value, velocity: 0, target: value }
}

/** Fixed sub-steps keep a stiff spring stable even across a dropped frame. */
const STEP = 1 / 240

export function stepSpring(state: Spring, seconds: number, stiffness: number, damping: number): void {
  let remaining = Math.min(seconds, 1 / 20)
  while (remaining > 0) {
    const dt = Math.min(STEP, remaining)
    const force = -stiffness * (state.value - state.target) - damping * state.velocity
    state.velocity += force * dt
    state.value += state.velocity * dt
    remaining -= dt
  }
}

export function springAtRest(state: Spring, epsilon = 0.0005): boolean {
  return Math.abs(state.velocity) < epsilon * 10 && Math.abs(state.value - state.target) < epsilon
}

export function settleSpring(state: Spring): void {
  state.value = state.target
  state.velocity = 0
}
