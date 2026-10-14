/**
 * Callback ref for a dock that floats over the bottom of a scrolling surface
 * (the glass composers). Publishes the dock's height as `--lg-bottom` on its
 * parent, so the content scrolling beneath it can pad itself clear and still
 * pass under the glass. Stable module function: React attaches it once.
 */
export function trackDockHeight(dock: HTMLElement | null): (() => void) | undefined {
  const parent = dock?.parentElement
  if (!dock || !parent) return undefined

  const publish = () => parent.style.setProperty('--lg-bottom', `${dock.offsetHeight}px`)
  publish()
  const observer = new ResizeObserver(publish)
  observer.observe(dock)

  return () => {
    observer.disconnect()
    parent.style.removeProperty('--lg-bottom')
  }
}
