import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, useReducedMotion } from 'framer-motion'
import { Bell, Camera, ClipboardCopy, ClipboardPaste, Globe, Info, Keyboard, LockKeyhole, MapPin, Maximize, Mic, Monitor, MousePointer2, Music2, Speaker, Timer, TriangleAlert, X } from 'lucide-react'
import type { ConnectionInfo, OverlayState, SitePermission } from '../../electron/browserUITypes'

const FEATURES: Record<SitePermission, { label: string; icon: ReactNode }> = {
  camera: { label: 'Use your camera', icon: <Camera /> },
  microphone: { label: 'Use your microphone', icon: <Mic /> },
  geolocation: { label: 'Know your location', icon: <MapPin /> },
  notifications: { label: 'Show notifications', icon: <Bell /> },
  'clipboard-read': { label: 'Read your clipboard', icon: <ClipboardPaste /> },
  'clipboard-write': { label: 'Write to your clipboard', icon: <ClipboardCopy /> },
  fullscreen: { label: 'Enter full screen', icon: <Maximize /> },
  pointerLock: { label: 'Lock your mouse pointer', icon: <MousePointer2 /> },
  'idle-detection': { label: 'Know when you are away', icon: <Timer /> },
  midi: { label: 'Use MIDI devices', icon: <Music2 /> },
  midiSysex: { label: 'Control MIDI devices with system messages', icon: <Music2 /> },
  'speaker-selection': { label: 'Choose an audio output', icon: <Speaker /> },
  keyboardLock: { label: 'Capture keyboard shortcuts', icon: <Keyboard /> },
  'window-management': { label: 'Manage windows across displays', icon: <Monitor /> },
}

const CONNECTION: Record<ConnectionInfo['status'], { title: string; description: string }> = {
  internal: { title: 'Orbit page', description: 'This is an internal or local page. There is no website connection to verify.' },
  http: { title: 'Not secure', description: 'Your connection to this site is not encrypted. Information you send could be viewed or changed by others. Avoid entering sensitive information.' },
  checking: { title: 'Checking connection', description: 'Orbit is waiting for Chromium to verify this connection.' },
  encrypted: { title: 'Connection is encrypted', description: 'Chromium reports a valid encrypted connection to this site with no connection security errors.' },
  insecure: { title: 'Connection is not secure', description: 'Chromium reported a connection security issue. This page may include insecure content. Avoid entering sensitive information.' },
  'certificate-error': { title: 'Certificate error', description: 'Chromium could not validate a certificate used by this page. Orbit blocked the invalid connection.' },
  unavailable: { title: 'Connection could not be verified', description: 'Orbit could not confirm this connection. Avoid entering sensitive information.' },
}

export function SiteControlsPopup({ state, close, decide }: { state: OverlayState; close: () => void; decide: (id: string, allow: boolean) => void }) {
  const reduced = useReducedMotion()
  const permission = state.permission
  const connection = state.connection ?? { url: '', status: 'unavailable' }
  const copy = CONNECTION[connection.status]
  const warning = ['http', 'insecure', 'certificate-error', 'unavailable'].includes(connection.status)
  let origin: string
  try { origin = new URL(connection.url).origin; if (origin === 'null') origin = 'Orbit' } catch { origin = 'Orbit' }
  return <Dialog.Root open onOpenChange={(open) => { if (!open) close() }}><Dialog.Portal forceMount>
    <Dialog.Overlay className="bp-site-backdrop" />
    <Dialog.Content asChild forceMount onCloseAutoFocus={(event) => event.preventDefault()} onOpenAutoFocus={(event) => {
      if (permission) { event.preventDefault(); document.querySelector<HTMLButtonElement>('.bp-site-block')?.focus() }
    }}><motion.section className="bp-site-popup" style={{ left: Math.max(12, Math.min(window.innerWidth - 372, state.anchor.x)), top: Math.max(8, Math.min(window.innerHeight - 360, state.anchor.y)) }} initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .14 }}>
      <header className="bp-site-header"><Dialog.Title>{permission ? 'Allow access?' : copy.title}</Dialog.Title><button type="button" className="bp-icon-button" aria-label={permission ? 'Close permission request' : 'Close connection details'} onClick={close}><X size={17} /></button></header>
      <p className="bp-site-origin">{permission?.origin ?? origin}</p>
      <Dialog.Description className="bp-site-description">{permission ? 'This website wants to:' : copy.description}</Dialog.Description>
      {permission ? <><ul className="bp-site-features">{permission.permissions.map((kind) => <li key={kind}><span aria-hidden="true">{FEATURES[kind].icon}</span><span>{FEATURES[kind].label}</span></li>)}</ul><p className="bp-site-note">Your choice lasts for this Orbit session.</p><div className="bp-site-actions"><button className="bp-button bp-site-block" type="button" onClick={() => decide(permission.id, false)}>Block</button><button className="bp-button bp-button-primary" type="button" onClick={() => decide(permission.id, true)}>Allow</button></div></> : <><div className={`bp-site-connection-symbol ${warning ? 'bp-site-warning' : ''}`} aria-hidden="true">{warning ? <TriangleAlert /> : connection.status === 'encrypted' ? <LockKeyhole /> : connection.status === 'internal' ? <Globe /> : <Info />}</div>{connection.detail ? <p className="bp-site-note">{connection.detail}</p> : null}<p className="bp-site-note">An encrypted connection does not guarantee that the website itself is trustworthy.</p></>}
    </motion.section></Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
