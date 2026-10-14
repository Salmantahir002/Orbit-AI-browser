import { KimoMascot } from './KimoMascot'

/** Every Kimo mascot act side by side, for the standalone preview page (kimo-preview.html). */
export function PreviewGallery() {
  const acts = [
    'idle',
    'bounce',
    'wave',
    'curious',
    'think',
    'nod',
    'glide',
    'look',
    'squint',
    'shake',
    'spin',
    'peek',
    'pulse',
    'cheer',
  ] as const

  return (
    <div style={{ padding: '32px 40px', color: '#fff', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '22px', fontWeight: 600, margin: '0 0 24px', letterSpacing: '-0.02em', color: 'rgba(255,255,255,0.95)' }}>
        Kimo Mascot Showcase (Spherical Orb)
      </h1>

      {/* Main interactive row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '32px', background: '#202325', padding: '24px 32px', borderRadius: '16px', marginBottom: '32px', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
          <KimoMascot />
          <span style={{ fontSize: '12px', color: '#8a9096' }}>Live Routine (~2s cycle)</span>
        </div>

        {/* Welcome screen layout preview (mascot on left of Kimo) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', background: '#161819', padding: '20px 24px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontSize: '11px', color: '#777', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Welcome Screen Header (Side-by-Side)</span>
          <div className="assistant-welcome-header" style={{ justifyContent: 'flex-start', margin: 0 }}>
            <div className="assistant-welcome-logo">
              <KimoMascot />
            </div>
            <h3>Kimo</h3>
          </div>
          <p style={{ margin: 0, fontSize: '12.5px', color: 'rgba(255,255,255,0.5)', maxWidth: '280px', lineHeight: 1.5 }}>
            Your prompt-defense assistant. Checked before it reaches the model.
          </p>
        </div>


        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Header Preview */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#181a1b', padding: '8px 16px', borderRadius: '10px', width: 'fit-content', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ width: 28, height: 28, display: 'grid', placeItems: 'center' }}>
              <KimoMascot compact />
            </div>
            <h2 style={{ margin: 0, fontSize: '14.5px', fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}>Kimo</h2>
            <span style={{ fontSize: '11px', color: '#666', marginLeft: '12px' }}>Header 28px</span>
          </div>

          {/* Avatar Preview */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#2a2e31', padding: '6px 12px', borderRadius: '8px', width: 'fit-content' }}>
            <div style={{ width: 19, height: 19, display: 'grid', placeItems: 'center' }}>
              <KimoMascot compact />
            </div>
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.85)', fontWeight: 500 }}>Chat Avatar 19px</span>
          </div>
        </div>
      </div>

      {/* Act Gallery Grid */}
      <h3 style={{ fontSize: '16px', color: '#a0a6ad', margin: '0 0 16px', fontWeight: 500 }}>
        14 Gesture Animations (2-Second Cycles)
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '14px' }}>
        {acts.map((act) => (
          <div
            key={act}
            style={{
              background: '#202325',
              padding: '16px 12px 14px',
              borderRadius: '14px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              border: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <div style={{ width: 108, height: 108, display: 'grid', placeItems: 'center' }}>
              <KimoMascot act={act} />
            </div>
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'rgba(255,255,255,0.85)', textTransform: 'capitalize', marginTop: '10px' }}>
              {act}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
