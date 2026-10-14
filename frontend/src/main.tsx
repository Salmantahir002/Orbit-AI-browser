import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { BrowserOverlayLoader } from './components/BrowserOverlayLoader'
import './styles/global.css'

const isBrowserOverlay = new URLSearchParams(window.location.search).get('surface') === 'browser-overlay'
if (isBrowserOverlay) document.documentElement.classList.add('browser-overlay-document')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isBrowserOverlay ? <Suspense fallback={null}><BrowserOverlayLoader /></Suspense> : <App />}
  </StrictMode>,
)
