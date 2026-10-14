import { useEffect, useState, type RefObject } from 'react'

export type PageBackdrop = {
  /** Bumped per new frame, so each one can fade in over the last. */
  key: number
  image: string
  /** Mean luminance of the frame, 0 (black) to 1 (white). */
  luminance: number
}

/** Pages scroll and animate without telling the shell; this catches up with them. */
const REFRESH_MS = 2500
/** After a load or navigation, give the page a moment to paint before sampling it. */
const SETTLE_MS = 450

/**
 * A small, regularly refreshed frame of the page beside the assistant panel,
 * for the panel's glass to sit on (see `browser:capture-backdrop` in main).
 * Frames are taken only while the panel is showing, the window is in front
 * and `pausedRef` is false (a drag-resize hides the guest view). On the home
 * page, which the shell draws itself, the shell's page area is sampled instead.
 * Returns the latest frame last, preceded by the one it is fading in over.
 */
export function usePageBackdrop(
  panelRef: RefObject<HTMLElement | null>,
  targetId: number | null,
  isHomePage: boolean,
  pausedRef: RefObject<boolean>,
): PageBackdrop[] {
  const [frames, setFrames] = useState<PageBackdrop[]>([])

  useEffect(() => {
    const api = window.electronAPI?.browser
    if (!api?.captureBackdrop) return
    let cancelled = false
    let inFlight = false
    let settleTimer = 0

    const capture = async () => {
      const panel = panelRef.current
      if (cancelled || inFlight || pausedRef.current || document.hidden) return
      if (!panel?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return

      inFlight = true
      let frame: { image: string; luminance: number } | null = null
      try {
        if (isHomePage) {
          // The page area left of the panel, in the shell's own DOM.
          const stage = document.querySelector('.webview-stack')?.getBoundingClientRect()
          if (stage) frame = await api.captureBackdrop(null, { x: stage.left, y: stage.top, width: stage.width, height: stage.height })
        } else if (targetId !== null) {
          frame = await api.captureBackdrop(targetId)
        }
      } catch {
        frame = null
      } finally {
        inFlight = false
      }
      if (cancelled || !frame) return
      const next = frame
      setFrames((previous) => {
        const latest = previous[previous.length - 1]
        if (latest?.image === next.image) return previous
        return [...previous.slice(-1), { key: (latest?.key ?? 0) + 1, ...next }]
      })
    }
    const captureSoon = () => {
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(capture, SETTLE_MS)
    }

    captureSoon()
    const interval = window.setInterval(capture, REFRESH_MS)
    const stopTabEvents = api.onTabEvent((event) => {
      if (event.webContentsId !== targetId) return
      if (event.type === 'did-finish-load' || event.type === 'did-stop-loading' || event.type === 'did-navigate-in-page') captureSoon()
    })
    window.addEventListener('focus', captureSoon)
    // The panel's container animates its width open and shut: catch the opening.
    const container = panelRef.current?.parentElement
    const openObserver = new ResizeObserver(captureSoon)
    if (container) openObserver.observe(container)
    return () => {
      cancelled = true
      window.clearTimeout(settleTimer)
      window.clearInterval(interval)
      stopTabEvents()
      window.removeEventListener('focus', captureSoon)
      openObserver.disconnect()
    }
  }, [panelRef, targetId, isHomePage, pausedRef])

  return frames
}
