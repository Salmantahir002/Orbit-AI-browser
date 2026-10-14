import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import sunSphereImage from './assets/sun-sphere.webp'
// layout.css first: liquid-glass.css must load after it, as the shell's glass surfaces expect.
import './styles/layout.css'
import { LiquidGlass } from './components/LiquidGlass'
import { createDeferredComponent } from './utils/deferredComponent'
import { cancelFrameTask, wakeFrameTask, type FrameTask } from './utils/frameLoop'
import { settleSpring, spring, springAtRest, stepSpring } from './utils/spring'

/** The capsule's padding around the drop, on each side. */
const SLIDE_INSET = 7
/** A press is a drag once it has moved this far. */
const DRAG_THRESHOLD = 3
/** How far along the track, as a fraction, a drag must reach to start. */
const START_AT = 0.95

/**
 * "Get started" as Liquid Glass: a glass capsule (refracting the orb behind
 * it) with a drop of glass for the handle. The drop runs on springs in the
 * loop all glass shares (utils/frameLoop), so a frame writes one transform and
 * one opacity and never measures layout. Dragged (from the drop or anywhere
 * on the capsule), it follows the pointer closely, stretches along its path
 * with speed and swells under the press; let go short of the end, it springs
 * home past rest and settles. A click, or Enter/Space, sends it sliding across
 * on its own before the app starts.
 */
function SlideStartButton({ onStart }: { onStart: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const handleRef = useRef<HTMLSpanElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)
  const onStartRef = useRef(onStart)

  useEffect(() => {
    onStartRef.current = onStart
  }, [onStart])

  useEffect(() => {
    const button = buttonRef.current
    const handle = handleRef.current
    const label = labelRef.current
    if (!button || !handle || !label) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    // Kept current by the ResizeObserver below, so no frame has to measure layout.
    let track = 0
    const measure = () => {
      track = Math.max(0, button.clientWidth - handle.offsetWidth - SLIDE_INSET * 2)
    }
    measure()

    const x = spring(0)
    let drag: { startX: number; startHandle: number; moved: boolean } | null = null
    let suppressClick = false
    // 'drag': started by dragging to the end, already announced; 'slide': a
    // click, announced once the drop arrives.
    let finishing: 'drag' | 'slide' | null = null
    let lastTime = 0

    const finish = () => {
      if (finishing === 'drag') return
      finishing = 'drag'
      onStartRef.current()
    }

    const task: FrameTask = {
      write: (time) => {
        const seconds = lastTime ? (time - lastTime) / 1000 : 1 / 60
        lastTime = time
        if (finishing) x.target = track
        if (reducedMotion.matches) settleSpring(x)
        else if (drag) stepSpring(x, seconds, 900, 50)
        else if (finishing) stepSpring(x, seconds, 260, 24)
        else stepSpring(x, seconds, 300, 15)

        // Speed stretches the drop along its path and thins it, volume kept roughly constant.
        const stretch = Math.min(Math.abs(x.velocity) / 1800, 0.35)
        handle.style.transform = `translateX(${x.value.toFixed(2)}px) scale(${(1 + stretch).toFixed(4)}, ${(1 - stretch * 0.45).toFixed(4)})`
        label.style.opacity = track > 0 ? Math.max(0, Math.min(1, 1 - x.value / (track * 0.7))).toFixed(3) : '1'

        if (finishing === 'slide' && x.value >= track * 0.97) {
          finishing = 'drag'
          onStartRef.current()
        }
        if (drag || !springAtRest(x, 0.05)) return true
        lastTime = 0
        return false
      },
    }
    const wake = () => wakeFrameTask(task)

    // A drag ends in a click on the button (pressed and released over it).
    // That click belongs to the drag, so it is swallowed; it fires in the same
    // task as the release, so a stray flag can't eat a later click or keypress.
    const spendClick = () => {
      suppressClick = true
      window.setTimeout(() => {
        suppressClick = false
      })
    }

    const handleDown = (event: PointerEvent) => {
      if (event.button !== 0 || finishing) return
      drag = { startX: event.clientX, startHandle: x.value, moved: false }
      button.classList.add('start-button--dragging')
      wake()
    }
    const handleMove = (event: PointerEvent) => {
      if (!drag) return
      const delta = event.clientX - drag.startX
      if (Math.abs(delta) > DRAG_THRESHOLD) drag.moved = true
      if (!drag.moved) return
      x.target = Math.min(track, Math.max(0, drag.startHandle + delta))
      if (x.target >= track * START_AT) {
        drag = null
        spendClick()
        button.classList.remove('start-button--dragging')
        finish()
      }
      wake()
    }
    const handleUp = () => {
      if (!drag) return
      // Short of the end the drop springs home; the button's click, if any, is spent.
      if (drag.moved) spendClick()
      drag = null
      x.target = 0
      button.classList.remove('start-button--dragging')
      wake()
    }
    const handleClick = () => {
      if (suppressClick || finishing) return
      finishing = 'slide'
      wake()
    }

    button.addEventListener('pointerdown', handleDown)
    button.addEventListener('click', handleClick)
    document.addEventListener('pointermove', handleMove, { passive: true })
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleUp)
    const resize = new ResizeObserver(() => {
      measure()
      wake()
    })
    resize.observe(button)
    return () => {
      button.removeEventListener('pointerdown', handleDown)
      button.removeEventListener('click', handleClick)
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.removeEventListener('pointercancel', handleUp)
      resize.disconnect()
      cancelFrameTask(task)
    }
  }, [])

  return (
    <div className="start-button-anchor">
      <button ref={buttonRef} className="start-button lg-host" type="button">
        <LiquidGlass refraction={44} bezel={16} blur={5} aberration={0} elasticity={0.16} />
        <span ref={handleRef} className="start-button__handle" aria-hidden="true">
          <span className="start-button__drop lg-host">
            <LiquidGlass refraction={26} bezel={12} blur={2} saturation={150} aberration={0} />
            <span className="start-button__arrow">→</span>
          </span>
        </span>
        <span ref={labelRef} className="start-button__label">
          Get started
        </span>
      </button>
    </div>
  )
}

function StartupScreen({
  onStart,
  isTransitioning,
}: {
  onStart: () => void
  isTransitioning: boolean
}) {
  const solarSystemRef = useRef<HTMLDivElement>(null)
  const [isGuideOpen, setIsGuideOpen] = useState(false)

  // Cancel the mouse-follow rAF before the transition frame paints. This keeps
  // it from competing with the solar-system burst as the swipe completes.
  useLayoutEffect(() => {
    // Captured once, so the cleanup resets the same node the loop moved.
    const solarSystem = solarSystemRef.current
    if (isTransitioning) {
      solarSystem?.style.removeProperty('transform')
      return
    }

    let active = true
    let mouseX = 0
    let mouseY = 0
    let currentX = 0
    let currentY = 0
    let rafId: number | null = null

    // Below this the movement is under a pixel and invisible, so the loop stops
    // rather than committing a new transform on every frame forever. An idle
    // welcome screen then costs the compositor nothing.
    const SETTLE_THRESHOLD_PX = 0.15

    const updatePosition = () => {
      if (!active) return
      rafId = null

      const deltaX = mouseX - currentX
      const deltaY = mouseY - currentY
      currentX += deltaX * 0.08
      currentY += deltaY * 0.08

      if (solarSystem) {
        solarSystem.style.transform = `translate3d(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px, 0)`
      }

      if (Math.abs(deltaX) > SETTLE_THRESHOLD_PX || Math.abs(deltaY) > SETTLE_THRESHOLD_PX) {
        rafId = requestAnimationFrame(updatePosition)
      }
    }

    const handleMouseMove = (e: MouseEvent) => {
      const targetX = (e.clientX - window.innerWidth / 2) / (window.innerWidth / 2)
      const targetY = (e.clientY - window.innerHeight / 2) / (window.innerHeight / 2)
      mouseX = targetX * 180 // Prominent 180px follow displacement
      mouseY = targetY * 180

      if (rafId === null) {
        rafId = requestAnimationFrame(updatePosition)
      }
    }

    window.addEventListener('mousemove', handleMouseMove, { passive: true })

    return () => {
      active = false
      window.removeEventListener('mousemove', handleMouseMove)
      if (rafId !== null) cancelAnimationFrame(rafId)
      solarSystem?.style.removeProperty('transform')
    }
  }, [isTransitioning])

  return (
    <main className={`startup-screen ${isTransitioning ? 'startup-screen--transitioning' : ''}`}>
      <div className="grain-layer" />
      <div className="aurora-layer" />

      <header className="startup-header">
        <button
          className={`sound-button ${isGuideOpen ? 'sound-button--active' : ''}`}
          type="button"
          aria-controls="defense-guide"
          aria-expanded={isGuideOpen}
          aria-label="How Orbit works"
          onClick={() => setIsGuideOpen((isOpen) => !isOpen)}
        >
          <span aria-hidden="true">?</span>
        </button>
      </header>

      {isGuideOpen ? (
        <aside className="startup-guide" id="defense-guide" aria-label="How Orbit works">
          <h2>How Orbit works</h2>
          <p>Browse normally, then scan a page or ask the AI Agent to detect hidden instructions before they can influence your next action.</p>
        </aside>
      ) : null}

      <section className="welcome-stage" aria-labelledby="welcome-title">
        <h1 id="welcome-title" className="welcome-title">
          Welcome to Orbit
        </h1>
        <div className="orb-wrap" aria-hidden="true">
          <div className="defense-orb">
            <img
              src={sunSphereImage}
              alt=""
              className="defense-orb-img"
              draggable={false}
              decoding="sync"
              loading="eager"
            />
          </div>

          {/* Solar System Orbits */}
          <div className="solar-system" ref={solarSystemRef}>
            <div className="orbit orbit--1">
              <div className="planet planet--1" />
            </div>
            <div className="orbit orbit--2">
              <div className="planet planet--2" />
            </div>
            <div className="orbit orbit--3">
              <div className="planet planet--3" />
            </div>
          </div>
        </div>
        <SlideStartButton onStart={onStart} />
      </section>
    </main>
  )
}

// The browser shell is most of the app's code and the welcome screen does not need it, so it
// loads as its own chunk. It is fetched once the welcome screen is idle, which leaves it ready by
// the time "Get started" has finished animating.
const BrowserShell = createDeferredComponent(() => import('./components/BrowserShell').then((module) => module.BrowserShell))

function App() {
  const [transitionState, setTransitionState] = useState<'welcome' | 'animating' | 'blown'>(() => new URLSearchParams(window.location.search).get('start') === 'browser' ? 'blown' : 'welcome')

  useEffect(() => {
    const idleId = window.requestIdleCallback(() => { void BrowserShell.load() })
    return () => window.cancelIdleCallback(idleId)
  }, [])

  // Clicking "Get started" before the idle prefetch has run must still start the fetch right away.
  useEffect(() => {
    if (transitionState !== 'welcome') void BrowserShell.load()
  }, [transitionState])

  const handleStart = () => {
    setTransitionState('animating')
    setTimeout(() => {
      setTransitionState('blown')
    }, 2000)
  }

  if (transitionState === 'blown') {
    return (
      <div className="blown-shell-wrapper">
        <BrowserShell />
      </div>
    )
  }

  return (
    <StartupScreen
      onStart={handleStart}
      isTransitioning={transitionState === 'animating'}
    />
  )
}

export default App
