interface ProductIconProps {
  sku: string
  size?: number
}

const icons: Record<string, (s: number) => JSX.Element> = {
  'COFFEE-001': (s) => (
    <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
      <circle cx="20" cy="20" r="18" fill="#FFF7ED" />
      {/* Coffee beans */}
      <ellipse cx="14" cy="18" rx="6" ry="9" fill="#92400E" transform="rotate(-20 14 18)" />
      <path d="M 9 15 Q 14 18 19 21" stroke="#FCD34D" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <ellipse cx="26" cy="22" rx="6" ry="9" fill="#78350F" transform="rotate(20 26 22)" />
      <path d="M 21 19 Q 26 22 31 25" stroke="#FCD34D" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      {/* Steam */}
      <path d="M 16 8 Q 18 5 16 3" stroke="#E8D5BF" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M 24 8 Q 26 5 24 3" stroke="#E8D5BF" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  ),
  'MUG-001': (s) => (
    <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
      <circle cx="20" cy="20" r="18" fill="#FFF7ED" />
      {/* Mug body */}
      <rect x="9" y="13" width="18" height="17" rx="3" fill="#E8631A" />
      <rect x="11" y="15" width="14" height="13" rx="2" fill="#FB923C" />
      {/* Handle */}
      <path d="M 27 17 Q 34 17 34 21 Q 34 25 27 25" stroke="#C2410C" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      {/* Rim */}
      <rect x="9" y="13" width="18" height="4" rx="2" fill="#C2410C" />
      {/* Coffee inside */}
      <rect x="11" y="15" width="14" height="5" rx="1" fill="#78350F" opacity="0.6" />
    </svg>
  ),
  'TOTE-001': (s) => (
    <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
      <circle cx="20" cy="20" r="18" fill="#FFF7ED" />
      {/* Bag body */}
      <path d="M 10 17 L 12 32 Q 12 34 14 34 L 26 34 Q 28 34 28 32 L 30 17 Z" fill="#D97706" />
      <path d="M 10 17 L 12 32 Q 12 34 14 34 L 26 34 Q 28 34 28 32 L 30 17 Z" fill="none" stroke="#92400E" strokeWidth="1" />
      {/* Top bar */}
      <rect x="10" y="15" width="20" height="4" rx="2" fill="#B45309" />
      {/* Handles */}
      <path d="M 14 15 Q 14 8 20 8 Q 26 8 26 15" stroke="#92400E" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      {/* Stitch detail */}
      <line x1="20" y1="20" x2="20" y2="32" stroke="#FCD34D" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
    </svg>
  ),
  'NB-001': (s) => (
    <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
      <circle cx="20" cy="20" r="18" fill="#FFF7ED" />
      {/* Book cover */}
      <rect x="10" y="9" width="20" height="24" rx="2" fill="#4338CA" />
      <rect x="12" y="9" width="18" height="24" rx="1" fill="#6366F1" />
      {/* Spine */}
      <rect x="10" y="9" width="4" height="24" rx="2" fill="#3730A3" />
      {/* Pages */}
      <rect x="14" y="11" width="14" height="20" rx="1" fill="#EEF2FF" />
      {/* Lines */}
      <line x1="16" y1="15" x2="26" y2="15" stroke="#C7D2FE" strokeWidth="1" strokeLinecap="round" />
      <line x1="16" y1="18" x2="26" y2="18" stroke="#C7D2FE" strokeWidth="1" strokeLinecap="round" />
      <line x1="16" y1="21" x2="26" y2="21" stroke="#C7D2FE" strokeWidth="1" strokeLinecap="round" />
      <line x1="16" y1="24" x2="22" y2="24" stroke="#C7D2FE" strokeWidth="1" strokeLinecap="round" />
      {/* Dots for dot grid */}
      <circle cx="19" cy="27" r="0.8" fill="#A5B4FC" />
      <circle cx="22" cy="27" r="0.8" fill="#A5B4FC" />
      <circle cx="25" cy="27" r="0.8" fill="#A5B4FC" />
    </svg>
  ),
  'GIFT-001': (s) => (
    <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
      <circle cx="20" cy="20" r="18" fill="#FFF7ED" />
      {/* Box base */}
      <rect x="9" y="19" width="22" height="14" rx="2" fill="#E85D04" />
      <rect x="9" y="19" width="22" height="14" rx="2" fill="none" stroke="#C2410C" strokeWidth="1" />
      {/* Box lid */}
      <rect x="8" y="15" width="24" height="6" rx="2" fill="#C2410C" />
      {/* Ribbon vertical */}
      <rect x="18" y="15" width="4" height="18" rx="1" fill="#FCD34D" />
      {/* Ribbon horizontal */}
      <rect x="8" y="18" width="24" height="4" rx="1" fill="#FCD34D" />
      {/* Bow left */}
      <path d="M 20 15 Q 12 8 14 14" stroke="#F59E0B" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* Bow right */}
      <path d="M 20 15 Q 28 8 26 14" stroke="#F59E0B" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* Bow center */}
      <circle cx="20" cy="15" r="2.5" fill="#FBBF24" />
    </svg>
  ),
}

export default function ProductIcon({ sku, size = 56 }: ProductIconProps) {
  const iconFn = icons[sku]
  if (!iconFn) {
    return (
      <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
        <circle cx="20" cy="20" r="18" fill="#F3F4F6" />
        <rect x="12" y="12" width="16" height="16" rx="2" fill="#9CA3AF" />
      </svg>
    )
  }
  return iconFn(size)
}
