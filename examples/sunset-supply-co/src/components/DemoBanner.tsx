export default function DemoBanner() {
  return (
    <div className="demo-banner">
      <div className="demo-banner-inner">
        <a
          className="demo-banner-logo"
          href="https://bahama.ai"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L2 7l10 5 10-5-10-5z" fill="#F59E0B" />
            <path d="M2 17l10 5 10-5" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" fill="none" />
            <path d="M2 12l10 5 10-5" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
          Bahama
        </a>

        <div className="demo-banner-dot" />

        <div className="demo-banner-copy">
          <strong>Built by an AI coding agent.</strong>{' '}
          A full-stack company dashboard deployed through Bahama to Vercel and Neon.
        </div>

        <div className="demo-banner-pills">
          <span className="demo-pill green">
            <span className="demo-pill-dot" />
            Database Live
          </span>
          <span className="demo-pill green">
            <span className="demo-pill-dot" />
            Serverless
          </span>
          <span className="demo-pill">Vercel + Neon</span>
        </div>
      </div>
    </div>
  )
}
