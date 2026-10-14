import { useEffect, useRef, type ReactNode } from 'react'
import { LiquidGlass } from './LiquidGlass'
import { cancelFrameTask, wakeFrameTask, type FrameTask } from '../utils/frameLoop'
import { settleSpring, spring, springAtRest, stepSpring } from '../utils/spring'

export type GlassSwitchOption<T extends string> = { id: T; label: ReactNode }

/** The capsule's inner padding, which the lens travels inside. */
const INSET = 3
/** A press is a drag once it has moved this far. */
const DRAG_THRESHOLD = 3

type Props<T extends string> = {
  options: Array<GlassSwitchOption<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  /**
   * Names the parts: `<prefix>-switch` (the capsule), `<prefix>-lens`
   * (`--lifted` while pressed) and `<prefix>-tab` (`--active` when selected).
   * The capsule must lay its tabs out in equal columns, so the lens travels
   * exactly one tab.
   */
  classPrefix: string
  /** The capsule glass's colour fringing (see LiquidGlass); 0 is the cheaper single-pass refraction. */
  aberration?: number
}

/**
 * A segmented control of glass: a glass capsule whose selection is a drop of
 * glass, the lens. The lens runs on springs. A new selection sends it sliding
 * with momentum, stretched along its path in proportion to its speed and
 * squashed as it lands. A press lifts it (it swells and clears, like a drop
 * under a fingertip), and it can be dragged across the capsule; let go, it
 * drops onto the nearest tab. The tabs stay real buttons, so keyboard
 * selection and plain clicks work as before.
 */
export function GlassSwitch<T extends string>({ options, value, onChange, ariaLabel, classPrefix, aberration }: Props<T>) {
  const switchRef = useRef<HTMLDivElement>(null)
  const lensRef = useRef<HTMLSpanElement>(null)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value))
  const latestRef = useRef({ options, onChange, selectedIndex })
  const selectRef = useRef<((index: number) => void) | null>(null)

  useEffect(() => {
    latestRef.current = { options, onChange, selectedIndex }
  }, [options, onChange, selectedIndex])

  useEffect(() => {
    selectRef.current?.(selectedIndex)
  }, [selectedIndex])

  useEffect(() => {
    const root = switchRef.current
    const lens = lensRef.current
    if (!root || !lens) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const lensClass = `${classPrefix}-lens--lifted`
    const count = () => latestRef.current.options.length
    // Kept current by the ResizeObserver below, so no frame has to measure layout.
    let innerWidth = root.clientWidth
    const tabWidth = () => (innerWidth - INSET * 2) / count()

    let selected = latestRef.current.selectedIndex
    const x = spring(selected * tabWidth())
    const lift = spring(1)
    let drag: { startX: number; startLens: number; moved: boolean } | null = null
    let suppressClick = false
    let lastTime = 0

    // Runs in the loop shared with the glass surfaces (see utils/frameLoop).
    const task: FrameTask = {
      write: (time) => {
        const seconds = lastTime ? (time - lastTime) / 1000 : 1 / 60
        lastTime = time
        if (!drag) x.target = selected * tabWidth()
        if (reducedMotion.matches) {
          settleSpring(x)
          settleSpring(lift)
        } else {
          stepSpring(x, seconds, drag ? 900 : 340, drag ? 50 : 23)
          stepSpring(lift, seconds, 420, 19)
        }
        // Speed stretches the drop along its path and thins it, volume kept roughly constant.
        const stretch = Math.min(Math.abs(x.velocity) / 1500, 0.42)
        const scaleX = lift.value * (1 + stretch)
        const scaleY = lift.value * (1 - stretch * 0.45)
        lens.style.transform = `translateX(${x.value.toFixed(2)}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`
        if (drag || !springAtRest(x, 0.05) || !springAtRest(lift)) return true
        lastTime = 0
        return false
      },
    }
    const wake = () => wakeFrameTask(task)
    selectRef.current = (index) => {
      if (index < 0) return
      selected = index
      wake()
    }

    const handleDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      suppressClick = false
      drag = { startX: event.clientX, startLens: x.value, moved: false }
      lift.target = 1.12
      lens.classList.add(lensClass)
      wake()
    }
    const handleMove = (event: PointerEvent) => {
      if (!drag) return
      const delta = event.clientX - drag.startX
      if (Math.abs(delta) > DRAG_THRESHOLD) drag.moved = true
      if (!drag.moved) return
      x.target = Math.min(tabWidth() * (count() - 1), Math.max(0, drag.startLens + delta))
      wake()
    }
    const handleUp = () => {
      if (!drag) return
      const moved = drag.moved
      drag = null
      lift.target = 1
      lens.classList.remove(lensClass)
      if (moved) {
        // The drop lands on the nearest tab; the button's own click, if any, is spent.
        selected = Math.round(x.target / tabWidth())
        suppressClick = true
        const { options: latestOptions, onChange: latestOnChange } = latestRef.current
        latestOnChange(latestOptions[selected].id)
      }
      wake()
    }
    const handleClick = (event: MouseEvent) => {
      if (!suppressClick) return
      suppressClick = false
      event.stopPropagation()
    }

    lens.style.transform = `translateX(${x.value}px)`
    root.addEventListener('pointerdown', handleDown)
    root.addEventListener('click', handleClick, true)
    document.addEventListener('pointermove', handleMove, { passive: true })
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleUp)
    const resize = new ResizeObserver(() => {
      innerWidth = root.clientWidth
      wake()
    })
    resize.observe(root)
    return () => {
      selectRef.current = null
      root.removeEventListener('pointerdown', handleDown)
      root.removeEventListener('click', handleClick, true)
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.removeEventListener('pointercancel', handleUp)
      resize.disconnect()
      cancelFrameTask(task)
    }
  }, [classPrefix])

  return (
    <div ref={switchRef} className={`${classPrefix}-switch lg-host`} role="tablist" aria-label={ariaLabel}>
      <LiquidGlass refraction={56} bezel={14} blur={6} elasticity={0.22} aberration={aberration} />
      <span ref={lensRef} className={`${classPrefix}-lens`} aria-hidden="true"><span /></span>
      {options.map((option) => (
        <button
          key={option.id}
          className={`${classPrefix}-tab ${value === option.id ? `${classPrefix}-tab--active` : ''}`}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
