import { createElement, useEffect, useState, type ComponentType } from 'react'

/**
 * A component whose code is fetched on demand, without `React.lazy`/`Suspense`.
 *
 * A lazy component that suspends behind a freshly mounted Suspense boundary commits its
 * fallback and then holds the real content back for 300ms (React's fallback throttle), even
 * when the chunk is already cached. That delay would land on the first open of every surface.
 * Here the loaded component lives in state instead: rendering the wrapper starts the import if
 * it has not happened yet, and once it has (`load()` can prefetch it), the component renders
 * on the very first pass. Nothing suspends and no fallback is shown.
 *
 * Create these at module scope. Rendering one mounts it, so mount it only when it is wanted.
 */
export type DeferredComponent<P extends object> = ComponentType<P> & {
  /** Starts (or joins) the import, e.g. to prefetch while idle. Safe to call repeatedly. */
  load: () => Promise<ComponentType<P>>
}

export function createDeferredComponent<P extends object>(
  importer: () => Promise<ComponentType<P>>,
): DeferredComponent<P> {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<ComponentType<P>> | null = null
  const load = () => (pending ??= importer().then((component) => (loaded = component)))

  function Deferred(props: P) {
    const [Component, setComponent] = useState<ComponentType<P> | null>(() => loaded)

    useEffect(() => {
      if (Component) return undefined
      let live = true
      void load().then((component) => {
        if (live) setComponent(() => component)
      })
      return () => { live = false }
    }, [Component])

    return Component ? createElement(Component, props) : null
  }

  return Object.assign(Deferred, { load })
}
