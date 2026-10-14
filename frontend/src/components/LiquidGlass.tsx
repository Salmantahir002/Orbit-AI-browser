import { useEffect, useId, useRef } from 'react'
import { cancelFrameTask, wakeFrameTask, type FrameTask } from '../utils/frameLoop'
import { settleSpring, spring, springAtRest, stepSpring } from '../utils/spring'
import '../styles/liquid-glass.css'

type LiquidGlassProps = {
  /** Peak shift, in px, of the backdrop at the rim; 0 drops the refraction
   * filter (frosted glass only), the cheaper choice for large, scrolling surfaces. */
  refraction?: number
  /** Width in px of the curved rim; the middle stays flat. */
  bezel?: number
  /** Backdrop blur in px. */
  blur?: number
  /** Backdrop saturation in percent. */
  saturation?: number
  /** Splits the colour channels at the rim the way real glass does; 0 turns it off. */
  aberration?: number
  /** How far the surface leans and stretches toward an approaching pointer; 0 keeps it rigid. */
  elasticity?: number
}

/** Distance in px beyond the edge at which an approaching pointer starts to pull. */
const REACH = 160
/** Longest lean, in px, so the surface never drifts away from where it is clicked. */
const MAX_LEAN = 6

/**
 * Apple-style Liquid Glass for an existing element. Render it as the first
 * child of an element with the `lg-host` class: it paints the refracted
 * backdrop, tint, specular rim and pointer sheen beneath that element's own
 * content, and gives the element its elastic response to the pointer.
 *
 * Refraction follows liquid-glass-react (MIT, github.com/rdev/liquid-glass-react):
 * an SVG feDisplacementMap bends the backdrop. That library loads its map as an
 * image and applies the filter beside backdrop-filter; Chromium honours neither
 * on a backdrop, so here the map is computed inside the filter and the filter
 * runs in backdrop-filter itself. The filter region is the surface, so the
 * flood below is the surface's shape; blurring it gives a height field that
 * falls away only at the rim, and its slope (the convolutions) is the
 * displacement: zero across the flat middle, strongest at the edge, pointing
 * along the edge normal. No measuring, and it follows any size.
 *
 * The glass can bend only what the renderer paints. Guest pages are native
 * views, so the assistant's glass refracts the panel's own content and
 * ambient light, never the page beside it.
 */
export function LiquidGlass({
  refraction = 40,
  bezel = 14,
  blur = 10,
  saturation = 165,
  aberration = 1.5,
  elasticity = 0,
}: LiquidGlassProps) {
  const layerRef = useRef<HTMLSpanElement>(null)
  const filterId = `lg-${useId().replace(/[^\w-]/g, '')}`

  // Gaussian falloff of the height field, and the gain that lifts its peak
  // slope (at the edge, over a two-pixel difference) to a near-full shift.
  const deviation = Math.max(1, bezel / 2)
  const divisor = 2 / (deviation * Math.sqrt(2 * Math.PI)) / 0.48

  // Pointer physics, run on damped springs and written straight to the host's
  // style (no React render per frame):
  //  - lean: an approaching pointer draws the surface toward it;
  //  - stretch: a pointer sweeping past drags the surface out along its path,
  //    like a drop pulled by its surface tension, and it wobbles back;
  //  - swell: a press swells the surface, which springs back past rest on release.
  // The rim's highlight turns to face the pointer throughout. Lean and stretch
  // stop under the pointer and while focused, so a target or a caret holds still.
  //
  // Frames run in the loop all glass shares (utils/frameLoop): this surface is
  // measured in the read phase and styled in the write phase, so many surfaces
  // moving at once cost one layout per frame, not one each. The pointer's
  // custom properties go on the glass layers, not the host: they inherit, and
  // on the host every frame would restyle all of the host's content.
  useEffect(() => {
    const layers = layerRef.current
    const host = layers?.parentElement
    if (!layers || !host) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const x = spring(0)
    const y = spring(0)
    const scaleX = spring(1)
    const scaleY = spring(1)
    let pointer: { x: number; y: number; time: number } | null = null
    let velocity = { x: 0, y: 0 }
    let pressed = false
    let near = false
    let focused = host.matches(':focus-within')
    let lastTime = 0
    // Measured in the read phase.
    let rect: DOMRect | null = null
    let width = 0
    let height = 0

    const setTargets = () => {
      x.target = 0
      y.target = 0
      let sx = 1
      let sy = 1
      if (pointer && rect) {
        const dx = pointer.x - (rect.left + rect.width / 2)
        const dy = pointer.y - (rect.top + rect.height / 2)
        const gap = Math.hypot(Math.max(0, Math.abs(dx) - width / 2), Math.max(0, Math.abs(dy) - height / 2))
        const pull = gap >= REACH ? 0 : 1 - gap / REACH
        near = pull > 0

        layers.style.setProperty('--lg-angle', `${(Math.atan2(dy, dx) * 180) / Math.PI + 90}deg`)
        layers.style.setProperty('--lg-glint', pull.toFixed(3))
        layers.style.setProperty('--lg-x', `${Math.min(100, Math.max(0, ((pointer.x - rect.left) / rect.width) * 100))}%`)
        layers.style.setProperty('--lg-y', `${Math.min(100, Math.max(0, ((pointer.y - rect.top) / rect.height) * 100))}%`)

        const free = elasticity > 0 && pull > 0 && !focused
        if (free && gap > 0) {
          const lean = (value: number) => Math.max(-MAX_LEAN, Math.min(MAX_LEAN, value * elasticity * 0.1 * pull))
          x.target = lean(dx)
          y.target = lean(dy)
          const distance = Math.hypot(dx, dy)
          const reachOut = Math.min(distance / 300, 1) * elasticity * pull
          sx += (Math.abs(dx) / distance) * reachOut * 0.3 - (Math.abs(dy) / distance) * reachOut * 0.15
          sy += (Math.abs(dy) / distance) * reachOut * 0.3 - (Math.abs(dx) / distance) * reachOut * 0.15
        }
        const speed = Math.hypot(velocity.x, velocity.y)
        if (free && speed > 1) {
          // Half strength under the pointer: the surface still feels liquid, but barely shifts.
          const drag = Math.min(speed / 2200, 1) * elasticity * 1.5 * pull * (gap === 0 ? 0.5 : 1)
          sx += (Math.abs(velocity.x) / speed) * drag * 0.35 - (Math.abs(velocity.y) / speed) * drag * 0.15
          sy += (Math.abs(velocity.y) / speed) * drag * 0.35 - (Math.abs(velocity.x) / speed) * drag * 0.15
        }
        if (pressed) {
          const swell = 1 + Math.min(0.045, 7 / Math.max(width, height))
          sx *= swell
          sy *= swell
        }
      } else {
        near = false
        layers.style.setProperty('--lg-glint', '0')
      }
      scaleX.target = Math.min(1.15, Math.max(0.88, sx))
      scaleY.target = Math.min(1.15, Math.max(0.88, sy))
    }

    const task: FrameTask = {
      read: () => {
        if (!pointer) return
        rect = host.getBoundingClientRect()
        width = host.offsetWidth
        height = host.offsetHeight
      },
      write: (time) => {
        const seconds = lastTime ? (time - lastTime) / 1000 : 1 / 60
        lastTime = time
        // The pointer's momentum fades once it stops moving.
        const fade = Math.exp(-seconds * 10)
        velocity = { x: velocity.x * fade, y: velocity.y * fade }
        setTargets()

        if (reducedMotion.matches) {
          for (const state of [x, y, scaleX, scaleY]) settleSpring(state)
          host.style.transform = ''
          lastTime = 0
          return false
        }
        stepSpring(x, seconds, 220, 16)
        stepSpring(y, seconds, 220, 16)
        stepSpring(scaleX, seconds, 320, 17)
        stepSpring(scaleY, seconds, 320, 17)

        const resting = springAtRest(x, 0.05) && springAtRest(y, 0.05) && springAtRest(scaleX) && springAtRest(scaleY)
        const moving = near && Math.hypot(velocity.x, velocity.y) > 1
        host.style.transform = resting && x.target === 0 && y.target === 0 && scaleX.target === 1 && scaleY.target === 1
          ? ''
          : `translate(${x.value.toFixed(2)}px, ${y.value.toFixed(2)}px) scale(${scaleX.value.toFixed(4)}, ${scaleY.value.toFixed(4)})`
        if (!resting || moving || pressed) return true
        lastTime = 0
        return false
      },
    }
    const wake = () => wakeFrameTask(task)

    const handleMove = (event: PointerEvent) => {
      const now = event.timeStamp
      if (pointer && now > pointer.time) {
        const dt = (now - pointer.time) / 1000
        const instant = { x: (event.clientX - pointer.x) / dt, y: (event.clientY - pointer.y) / dt }
        velocity = { x: velocity.x * 0.6 + instant.x * 0.4, y: velocity.y * 0.6 + instant.y * 0.4 }
      }
      pointer = { x: event.clientX, y: event.clientY, time: now }
      wake()
    }
    // relatedTarget is null when the pointer leaves the renderer, including
    // onto a guest page's native view.
    const handleOut = (event: PointerEvent) => {
      if (event.relatedTarget) return
      pointer = null
      pressed = false
      wake()
    }
    const handleDown = (event: PointerEvent) => {
      // Disabled buttons still receive pointer events; they shouldn't swell.
      if (event.button !== 0 || host.matches(':disabled')) return
      pressed = true
      wake()
    }
    const handleUp = () => {
      if (!pressed) return
      pressed = false
      wake()
    }
    const handleBlur = () => {
      pointer = null
      pressed = false
      wake()
    }
    const handleFocusIn = () => {
      focused = true
      wake()
    }
    const handleFocusOut = (event: FocusEvent) => {
      focused = host.contains(event.relatedTarget as Node | null)
      wake()
    }

    document.addEventListener('pointermove', handleMove, { passive: true })
    document.addEventListener('pointerout', handleOut, { passive: true })
    document.addEventListener('pointerup', handleUp, { passive: true })
    document.addEventListener('pointercancel', handleUp, { passive: true })
    host.addEventListener('pointerdown', handleDown, { passive: true })
    host.addEventListener('focusin', handleFocusIn)
    host.addEventListener('focusout', handleFocusOut)
    window.addEventListener('blur', handleBlur)
    return () => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerout', handleOut)
      document.removeEventListener('pointerup', handleUp)
      document.removeEventListener('pointercancel', handleUp)
      host.removeEventListener('pointerdown', handleDown)
      host.removeEventListener('focusin', handleFocusIn)
      host.removeEventListener('focusout', handleFocusOut)
      window.removeEventListener('blur', handleBlur)
      cancelFrameTask(task)
      host.style.transform = ''
    }
  }, [elasticity])

  const frost = `blur(${blur}px) saturate(${saturation}%)`
  if (refraction === 0) {
    return (
      <span ref={layerRef} className="lg-layers" aria-hidden="true">
        <span className="lg-warp" style={{ backdropFilter: frost }} />
        <span className="lg-tint" />
        <span className="lg-sheen" />
        <span className="lg-rim" />
      </span>
    )
  }

  return (
    <span ref={layerRef} className="lg-layers" aria-hidden="true">
      <svg className="lg-defs" focusable="false">
        <filter id={filterId} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
          <feFlood floodColor="#fff" result="surface" />
          <feGaussianBlur in="surface" stdDeviation={deviation} result="soft" />
          <feColorMatrix in="soft" type="matrix" values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1" result="height" />
          <feConvolveMatrix in="height" order="3" kernelMatrix="0 0 0  1 0 -1  0 0 0" divisor={divisor} bias="0.5" preserveAlpha="true" edgeMode="duplicate" result="slopeX" />
          <feConvolveMatrix in="height" order="3" kernelMatrix="0 1 0  0 0 0  0 -1 0" divisor={divisor} bias="0.5" preserveAlpha="true" edgeMode="duplicate" result="slopeY" />
          <feColorMatrix in="slopeX" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1" result="mapX" />
          <feColorMatrix in="slopeY" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1" result="mapY" />
          <feComposite in="mapX" in2="mapY" operator="arithmetic" k2="1" k3="1" result="map" />
          {aberration === 0 ? (
            <feDisplacementMap in="SourceGraphic" in2="map" scale={refraction} xChannelSelector="R" yChannelSelector="G" />
          ) : (
            <>
              {/* One displacement per colour channel, each a little stronger: the
                  channels part at the rim, where the map is non-neutral, only. */}
              <feDisplacementMap in="SourceGraphic" in2="map" scale={refraction} xChannelSelector="R" yChannelSelector="G" result="shiftR" />
              <feColorMatrix in="shiftR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
              <feDisplacementMap in="SourceGraphic" in2="map" scale={refraction * (1 + aberration * 0.05)} xChannelSelector="R" yChannelSelector="G" result="shiftG" />
              <feColorMatrix in="shiftG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
              <feDisplacementMap in="SourceGraphic" in2="map" scale={refraction * (1 + aberration * 0.1)} xChannelSelector="R" yChannelSelector="G" result="shiftB" />
              <feColorMatrix in="shiftB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
              <feComposite in="red" in2="green" operator="arithmetic" k2="1" k3="1" result="redGreen" />
              <feComposite in="redGreen" in2="blue" operator="arithmetic" k2="1" k3="1" />
            </>
          )}
        </filter>
      </svg>
      <span className="lg-warp" style={{ backdropFilter: `${frost} url(#${filterId})` }} />
      <span className="lg-tint" />
      <span className="lg-sheen" />
      <span className="lg-rim" />
    </span>
  )
}
