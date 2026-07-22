interface LogoProps {
  size?: number
  showText?: boolean
}

export default function Logo({ size = 36, showText = true }: LogoProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <svg
        width={size}
        height={Math.round(size * 0.8)}
        viewBox="0 0 45 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Glow beneath sun */}
        <ellipse cx="22.5" cy="28" rx="16" ry="5" fill="#FED7AA" opacity="0.6" />
        {/* Rising sun arc */}
        <path d="M 8 28 A 14.5 14.5 0 0 1 37 28" fill="#FBBF24" />
        {/* Sun center highlight */}
        <path d="M 13 28 A 9.5 9.5 0 0 1 32 28" fill="#F59E0B" />
        {/* Horizon line */}
        <line x1="2" y1="28" x2="43" y2="28" stroke="#E85D04" strokeWidth="2.5" strokeLinecap="round" />
        {/* Ground shadow lines */}
        <line x1="6" y1="32" x2="39" y2="32" stroke="#E8D5BF" strokeWidth="1.5" strokeLinecap="round" />
        {/* Rays */}
        <line x1="22.5" y1="10" x2="22.5" y2="5" stroke="#FBBF24" strokeWidth="2" strokeLinecap="round" />
        <line x1="32" y1="14" x2="35.5" y2="10.5" stroke="#FBBF24" strokeWidth="2" strokeLinecap="round" />
        <line x1="13" y1="14" x2="9.5" y2="10.5" stroke="#FBBF24" strokeWidth="2" strokeLinecap="round" />
        <line x1="37.5" y1="22" x2="42" y2="20.5" stroke="#FBBF24" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="7.5" y1="22" x2="3" y2="20.5" stroke="#FBBF24" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {showText && (
        <div style={{ lineHeight: 1.1 }}>
          <div style={{ fontWeight: 800, fontSize: size * 0.42, letterSpacing: '-.02em', color: '#1C0A00' }}>
            Sunset Supply
          </div>
          <div style={{ fontWeight: 500, fontSize: size * 0.28, letterSpacing: '.08em', color: '#A8714A', textTransform: 'uppercase' }}>
            Co.
          </div>
        </div>
      )}
    </div>
  )
}
