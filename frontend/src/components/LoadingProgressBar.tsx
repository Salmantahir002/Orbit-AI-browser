import { useEffect, useState, useRef } from 'react'

type LoadingProgressBarProps = {
  isLoading: boolean
}

export function LoadingProgressBar({ isLoading }: LoadingProgressBarProps) {
  const [progress, setProgress] = useState(0)
  const [visible, setVisible] = useState(false)
  const timeoutRef = useRef<number | null>(null)
  const intervalRef = useRef<number | null>(null)

  useEffect(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    if (isLoading) {
      const rafId = window.requestAnimationFrame(() => {
        setVisible(true)
        setProgress(20)
      })

      // Advance through realistic phases while loading
      timeoutRef.current = window.setTimeout(() => {
        setProgress(48)

        intervalRef.current = window.setInterval(() => {
          setProgress((prev) => {
            if (prev >= 90) {
              if (intervalRef.current !== null) {
                window.clearInterval(intervalRef.current)
                intervalRef.current = null
              }
              return 90
            }
            // Slowly crawl up to 90%
            const increment = Math.max(1, (90 - prev) * 0.12)
            return Math.min(90, prev + increment)
          })
        }, 280)
      }, 200)

      return () => {
        window.cancelAnimationFrame(rafId)
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current)
        }
        if (intervalRef.current !== null) {
          window.clearInterval(intervalRef.current)
        }
      }
    }

    // Completed loading: snap to 100% then fade out
    const completeRafId = window.requestAnimationFrame(() => {
      setProgress(100)
    })
    timeoutRef.current = window.setTimeout(() => {
      setVisible(false)
      setProgress(0)
    }, 350)

    return () => {
      window.cancelAnimationFrame(completeRafId)
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
      }
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current)
      }
    }
  }, [isLoading])

  if (!visible && progress === 0) {
    return null
  }

  return (
    <div
      className="loading-progress-bar-container"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
      aria-hidden={!visible}
    >
      <div
        className={`loading-progress-bar ${!isLoading ? 'loading-progress-bar--complete' : ''}`}
        style={{
          // transform, not width: scaling is composited, whereas animating width re-lays-out and
          // repaints the toolbar strip for as long as the page is loading.
          transform: `scaleX(${progress / 100})`,
          opacity: visible ? 1 : 0,
        }}
      />
    </div>
  )
}
