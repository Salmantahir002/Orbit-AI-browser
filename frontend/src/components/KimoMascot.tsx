import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import '../styles/kimo-mascot.css'

/**
 * Kimo — the assistant's mascot.
 *
 * A minimalist, ultra-clean floating spherical companion orb with expressive,
 * animated slanted capsule eyes. Built with layered vector SVG and 3D-styled
 * gradients, specular highlights, and soft ambient depth.
 *
 * Motion is driven by an act loop ('idle' | 'wave' | 'think' | 'look' | 'cheer' |
 * 'nod' | 'shake' | 'spin' | 'point') and reactive CSS keyframe animations.
 */

type Act =
  | 'idle'
  | 'wave'
  | 'bounce'
  | 'think'
  | 'curious'
  | 'look'
  | 'cheer'
  | 'nod'
  | 'shake'
  | 'spin'
  | 'peek'
  | 'glide'
  | 'pulse'
  | 'squint'

const ROUTINE: ReadonlyArray<readonly [Act, number]> = [
  ['idle', 2000],
  ['bounce', 2000],
  ['wave', 2000],
  ['curious', 2000],
  ['think', 2000],
  ['nod', 2000],
  ['glide', 2000],
  ['look', 2000],
  ['squint', 2000],
  ['shake', 2000],
  ['spin', 2000],
  ['peek', 2000],
  ['pulse', 2000],
  ['cheer', 2000],
]

const WAVE_MS = 2000
const ENTRY_MS = 800

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches,
  )

  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    const handleChange = () => setReduced(query.matches)
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  return reduced
}

/**
 * Whether any of the element is on screen. The SVG's keyframes repaint on the
 * main thread every frame, and Kimo is mounted in places nobody is looking at:
 * the assistant panel stays mounted (warm) while closed, and every reply in a
 * long chat carries its own avatar. Off screen, the act loop stops and the
 * animations pause where they are.
 */
function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [onScreen, setOnScreen] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    // A ratio, not isIntersecting: inside the closed panel (clipped to zero width)
    // the avatar can still touch the viewport along an edge, which counts as intersecting.
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.intersectionRatio > 0), { threshold: [0, 0.01] })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return onScreen
}

export function KimoMascot({
  compact = false,
  act: forcedAct,
}: {
  compact?: boolean
  act?: Act
}) {
  const uid = useId().replace(/:/g, '')
  const reduced = usePrefersReducedMotion()
  const [act, setAct] = useState<Act>(forcedAct ?? 'idle')
  const timerRef = useRef<number | null>(null)
  const indexRef = useRef(0)
  const resumeRef = useRef<(() => void) | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const onScreen = useOnScreen(svgRef)

  useEffect(() => {
    if (reduced || forcedAct || !onScreen) return

    indexRef.current = Math.floor(Math.random() * ROUTINE.length)

    function advance() {
      const [nextAct, holdMs] = ROUTINE[indexRef.current % ROUTINE.length]
      indexRef.current += 1
      setAct(nextAct)
      timerRef.current = window.setTimeout(advance, holdMs)
    }

    resumeRef.current = advance
    timerRef.current = window.setTimeout(advance, ENTRY_MS)

    return () => {
      resumeRef.current = null
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [reduced, forcedAct, onScreen])

  const handlePointerEnter = () => {
    const resume = resumeRef.current
    if (reduced || compact || forcedAct || !resume) return
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setAct('wave')
    timerRef.current = window.setTimeout(resume, WAVE_MS)
  }

  const effectiveAct = forcedAct ?? act

  return (
    <svg
      ref={svgRef}
      className={`kimo ${compact ? 'kimo--compact' : ''}`}
      data-act={reduced ? 'idle' : effectiveAct}
      data-paused={onScreen ? undefined : ''}
      viewBox="0 0 200 200"
      fill="none"
      role="img"
      aria-label="Kimo"
      onPointerEnter={handlePointerEnter}
    >
      <defs>
        {/* Soft 3D spherical orb body gradient: light source top-left */}
        <radialGradient id={`${uid}-orb-body`} cx="36%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="45%" stopColor="#f8fafc" />
          <stop offset="78%" stopColor="#e2e8f0" />
          <stop offset="100%" stopColor="#cbd5e1" />
        </radialGradient>

        {/* Ambient bottom rim reflection (bounce light from ground) */}
        <linearGradient id={`${uid}-orb-rim`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="70%" stopColor="#ffffff" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.85" />
        </linearGradient>

        {/* Top-left specular gloss sheen */}
        <linearGradient id={`${uid}-orb-gloss`} x1="20%" y1="10%" x2="60%" y2="80%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="35%" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>

        {/* Deep sleek capsule eyes gradient */}
        <linearGradient id={`${uid}-eye-grad`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#1e293b" />
          <stop offset="45%" stopColor="#0f172a" />
          <stop offset="100%" stopColor="#020617" />
        </linearGradient>

        {/* Floor floating drop shadow */}
        <radialGradient id={`${uid}-floor-shadow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#020617" stopOpacity="0.45" />
          <stop offset="50%" stopColor="#020617" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#020617" stopOpacity="0" />
        </radialGradient>

        {/* Ambient aura glow */}
        <radialGradient id={`${uid}-aura-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#93c5fd" stopOpacity="0.32" />
          <stop offset="60%" stopColor="#60a5fa" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </radialGradient>

        {/* Soft blush radial gradient */}
        <radialGradient id={`${uid}-blush`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fb7185" stopOpacity="0.55" />
          <stop offset="60%" stopColor="#fb7185" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#fb7185" stopOpacity="0" />
        </radialGradient>

        {/* Orb clipping mask to keep gloss and shadows perfectly round */}
        <clipPath id={`${uid}-orb-clip`}>
          <circle cx="100" cy="96" r="58" />
        </clipPath>
      </defs>

      {/* Floating Floor Shadow */}
      {!compact ? (
        <ellipse
          className="kimo__floor"
          cx="100"
          cy="176"
          rx="44"
          ry="7.5"
          fill={`url(#${uid}-floor-shadow)`}
        />
      ) : null}

      {/* Ambient Halo Aura */}
      {!compact ? (
        <ellipse
          className="kimo__aura"
          cx="100"
          cy="96"
          rx="76"
          ry="74"
          fill={`url(#${uid}-aura-glow)`}
        />
      ) : null}

      {/* Main Floating Group */}
      <g className="kimo__float">
        {/* Head / Spherical Body */}
        <g className="kimo__head">
          {/* Main 3D Sphere */}
          <circle
            className="kimo__sphere"
            cx="100"
            cy="96"
            r="58"
            fill={`url(#${uid}-orb-body)`}
          />

          {/* Shading, Specular Sheen and Rim Light (Clipped to Sphere) */}
          <g clipPath={`url(#${uid}-orb-clip)`}>
            {/* Ambient Occlusion Shadow on lower right contour */}
            <path
              d="M42 96a58 58 0 0 0 116 0c0 32-26 58-58 58s-58-26-58-58z"
              fill="#0f172a"
              opacity="0.09"
            />
            {/* Inner bottom rim reflection */}
            <circle cx="100" cy="96" r="58" fill={`url(#${uid}-orb-rim)`} />

            {/* Glossy top-left highlight streak */}
            <ellipse
              cx="76"
              cy="64"
              rx="34"
              ry="18"
              transform="rotate(-28 76 64)"
              fill={`url(#${uid}-orb-gloss)`}
            />

            {/* Specular pinpoint gleam */}
            <circle cx="68" cy="56" r="5" fill="#ffffff" opacity="0.95" />

            {/* Soft cheek blush (shows in happy/squint/peek acts) */}
            {!compact ? (
              <g className="kimo__blush">
                <ellipse cx="74" cy="98" rx="10" ry="6" fill={`url(#${uid}-blush)`} />
                <ellipse cx="132" cy="86" rx="10" ry="6" fill={`url(#${uid}-blush)`} />
              </g>
            ) : null}
          </g>

          {/* Eyes & Face Features */}
          <g className="kimo__face">
            {/* Standard Slanted Capsule Eyes (matching reference image) */}
            <g className="kimo__eyes kimo__eyes--rest">
              <g className="kimo__pupils">
                {/* Left capsule eye (tilted ~35deg) */}
                <g className="kimo__eye kimo__eye--left" transform="translate(92, 80) rotate(-35)">
                  <rect
                    x="-6.5"
                    y="-15"
                    width="13"
                    height="30"
                    rx="6.5"
                    fill={`url(#${uid}-eye-grad)`}
                  />
                  {/* Subtle inner eye catchlight */}
                  <circle cx="0.5" cy="-6" r="2.2" fill="#ffffff" opacity="0.8" />
                  <circle cx="-1" cy="7" r="1.3" fill="#60a5fa" opacity="0.5" />
                </g>

                {/* Right capsule eye (tilted ~35deg, elevated playfully) */}
                <g className="kimo__eye kimo__eye--right" transform="translate(122, 65) rotate(-35)">
                  <rect
                    x="-6"
                    y="-14"
                    width="12"
                    height="28"
                    rx="6"
                    fill={`url(#${uid}-eye-grad)`}
                  />
                  {/* Subtle inner eye catchlight */}
                  <circle cx="0.5" cy="-5.5" r="2" fill="#ffffff" opacity="0.8" />
                  <circle cx="-1" cy="6.5" r="1.2" fill="#60a5fa" opacity="0.5" />
                </g>
              </g>
            </g>

            {/* Alert / Thinking Eyes (slightly rounded wide capsules) */}
            <g className="kimo__eyes kimo__eyes--wide">
              <g className="kimo__eye" transform="translate(90, 78) rotate(-18)">
                <rect
                  x="-7.5"
                  y="-14"
                  width="15"
                  height="28"
                  rx="7.5"
                  fill={`url(#${uid}-eye-grad)`}
                />
                <circle cx="0" cy="-5" r="2.8" fill="#ffffff" opacity="0.85" />
              </g>
              <g className="kimo__eye" transform="translate(122, 65) rotate(-18)">
                <rect
                  x="-7.5"
                  y="-14"
                  width="15"
                  height="28"
                  rx="7.5"
                  fill={`url(#${uid}-eye-grad)`}
                />
                <circle cx="0" cy="-5" r="2.8" fill="#ffffff" opacity="0.85" />
              </g>
            </g>

            {/* Happy / Cheerful Arched Eyes (for cheer & wave acts) */}
            <g className="kimo__eyes kimo__eyes--happy">
              <path
                d="M82 82c2-10 12-12 18-2"
                stroke="#0f172a"
                strokeWidth="4.8"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M112 68c2-10 12-12 18-2"
                stroke="#0f172a"
                strokeWidth="4.8"
                strokeLinecap="round"
                fill="none"
              />
            </g>

            {/* Squint / Playful Eyes (for squint & peek acts) */}
            <g className="kimo__eyes kimo__eyes--squint">
              <g transform="translate(92, 80) rotate(-35)">
                <line
                  x1="-7"
                  y1="0"
                  x2="7"
                  y2="0"
                  stroke="#0f172a"
                  strokeWidth="4.5"
                  strokeLinecap="round"
                />
              </g>
              <g transform="translate(122, 65) rotate(-35)">
                <line
                  x1="-7"
                  y1="0"
                  x2="7"
                  y2="0"
                  stroke="#0f172a"
                  strokeWidth="4.5"
                  strokeLinecap="round"
                />
              </g>
            </g>
          </g>
        </g>


        {/* Thought bubbles (shown while thinking) */}
        {!compact ? (
          <g className="kimo__thought" fill="#60a5fa">
            <circle className="kimo__thought-dot" cx="146" cy="46" r="3.2" />
            <circle className="kimo__thought-dot" cx="157" cy="33" r="4.6" />
            <circle className="kimo__thought-dot" cx="170" cy="18" r="6.2" />
          </g>
        ) : null}
      </g>

      {/* Sparkles around mascot (shown during cheer & wave) */}
      {!compact ? (
        <g className="kimo__sparks">
          <path
            className="kimo__spark"
            d="M26 62l2.4 5.6L34 70l-5.6 2.4L26 78l-2.4-5.6L18 70l5.6-2.4L26 62z"
            fill="#93c5fd"
          />
          <circle className="kimo__spark" cx="174" cy="92" r="3" fill="#60a5fa" />
          <circle className="kimo__spark" cx="36" cy="136" r="2.4" fill="#bfdbfe" />
          <path
            className="kimo__spark"
            d="M166 42l1.6 3.8L171 47l-3.8 1.6L166 52l-1.6-3.8L161 47l3.8-1.6L166 42z"
            fill="#60a5fa"
          />
        </g>
      ) : null}
    </svg>
  )
}

