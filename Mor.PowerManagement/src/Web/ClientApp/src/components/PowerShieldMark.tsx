import { useId } from 'react'

type PowerShieldMarkProps = {
  className?: string
  title?: string
  variant?: 'color' | 'mono' | 'reverse'
}

/** Smart outlet shield: protection, branch power, and connected telemetry. */
export function PowerShieldMark({
  className,
  title = 'MOR Power smart outlet shield',
  variant = 'color',
}: PowerShieldMarkProps) {
  const id = useId().replace(/:/g, '')
  const mono = variant === 'mono'
  const reversed = variant === 'reverse'
  const shieldFill = mono ? '#0B2A4A' : `url(#shield-${id})`

  return (
    <svg
      className={className}
      viewBox="0 0 128 144"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`shield-${id}`} x1="64" y1="47" x2="64" y2="137" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2EC4F1" />
          <stop offset=".52" stopColor="#1E88E5" />
          <stop offset="1" stopColor="#0D47A1" />
        </linearGradient>
        <linearGradient id={`shade-${id}`} x1="56" y1="90" x2="106" y2="90" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0B2A4A" stopOpacity="0" />
          <stop offset=".58" stopColor="#0B2A4A" stopOpacity=".03" />
          <stop offset="1" stopColor="#0B2A4A" stopOpacity=".34" />
        </linearGradient>
        <clipPath id={`clip-${id}`}>
          <path d="M32 47h64a7 7 0 0 1 7 7v29c0 22-18 41-39 54a8 8 0 0 1-8 0C35 124 25 105 25 83V54a7 7 0 0 1 7-7Z" />
        </clipPath>
      </defs>

      {reversed && <rect width="128" height="144" rx="24" fill="#0B2A4A" />}

      <g className="power-mark-lines" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M42 48V27" stroke={mono ? '#0B2A4A' : reversed ? '#2EC4F1' : '#1E88E5'} strokeWidth="5" />
        <path d="M64 48V19" stroke={mono ? '#0B2A4A' : reversed ? '#2EC4F1' : '#1E88E5'} strokeWidth="5" />
        <path d="M86 48V32" stroke={reversed ? '#2EC4F1' : '#0B2A4A'} strokeWidth="5" />
      </g>
      <g className="power-mark-nodes" fill="none" strokeWidth="5">
        <circle cx="42" cy="19" r="7" stroke={mono ? '#0B2A4A' : reversed ? '#2EC4F1' : '#1E88E5'} strokeWidth="5" />
        <circle cx="64" cy="11" r="7" stroke={mono ? '#0B2A4A' : reversed ? '#2EC4F1' : '#1E88E5'} strokeWidth="5" />
        <circle cx="86" cy="24" r="7" stroke={reversed ? '#2EC4F1' : '#0B2A4A'} strokeWidth="5" />
      </g>

      <path
        className="power-mark-shield"
        d="M32 47h64a7 7 0 0 1 7 7v29c0 22-18 41-39 54a8 8 0 0 1-8 0C35 124 25 105 25 83V54a7 7 0 0 1 7-7Z"
        fill={shieldFill}
      />
      {!mono && (
        <rect
          x="56"
          y="47"
          width="52"
          height="96"
          fill={`url(#shade-${id})`}
          clipPath={`url(#clip-${id})`}
        />
      )}

      <rect
        className="power-mark-outlet-face"
        x="43"
        y="65"
        width="42"
        height="43"
        rx="10"
        fill="#FFFFFF"
      />
      <g className="power-mark-sockets" fill="#0B2A4A">
        <rect x="52" y="74" width="6" height="16" rx="3" />
        <rect x="70" y="74" width="6" height="16" rx="3" />
        <path d="M59 97q5 6 10 0" fill="none" stroke="#0B2A4A" strokeWidth="4" strokeLinecap="round" />
      </g>
    </svg>
  )
}
