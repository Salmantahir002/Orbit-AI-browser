import { lazy } from 'react'

// The native overlay loads its UI separately so Motion and Radix stay off the shell's first frame.
export const BrowserOverlayLoader = lazy(() => import('./BrowserOverlay').then((module) => ({ default: module.BrowserOverlay })))
