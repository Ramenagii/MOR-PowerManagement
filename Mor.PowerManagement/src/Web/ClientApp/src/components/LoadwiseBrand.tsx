import { motion } from 'framer-motion'

type LoadwiseBrandProps = {
  variant: 'intro' | 'header'
  showCopy?: boolean
  showProgress?: boolean
}

const sharedTransition = {
  type: 'spring',
  stiffness: 130,
  damping: 22,
  mass: 0.9,
} as const

export function LoadwiseBrand({
  variant,
  showCopy = false,
  showProgress = false,
}: LoadwiseBrandProps) {
  const bodyGradientId = `loadwise-body-${variant}`
  const faceGradientId = `loadwise-face-${variant}`

  return (
    <div className={`loadwise-brand ${variant}`}>
      <motion.div
        className="loadwise-mark"
        layoutId="loadwise-logo-mark"
        transition={sharedTransition}
      >
        <svg viewBox="0 0 260 330" role="img" aria-label="Loadwise logo">
          <defs>
            <linearGradient id={bodyGradientId} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor="#04b5df" />
              <stop offset="0.52" stopColor="#056da4" />
              <stop offset="1" stopColor="#0d1b3a" />
            </linearGradient>
            <linearGradient id={faceGradientId} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.56" stopColor="#f4f6f7" />
              <stop offset="1" stopColor="#d6dde2" />
            </linearGradient>
          </defs>
          <ellipse className="logo-shadow" cx="130" cy="305" rx="82" ry="13" />
          <path
            className="logo-body"
            d="M40 142h153l33 33v70c0 11-6 21-15 27l-58 42c-13 9-31 9-44 0l-58-42c-9-6-15-16-15-27v-99c0-8 6-14 14-14Z"
            fill={`url(#${bodyGradientId})`}
          />
          <path
            className="logo-corner"
            d="M192 142h1l33 33-40 40v-55c0-10 6-18 6-18Z"
          />
          <rect className="logo-slot" x="58" y="156" width="148" height="12" rx="6" />
          <rect className="logo-neck neck-left" x="72" y="72" width="12" height="70" rx="6" />
          <rect className="logo-neck neck-mid" x="124" y="36" width="12" height="106" rx="6" />
          <rect
            className="logo-neck neck-right"
            x="176"
            y="72"
            width="12"
            height="70"
            rx="6"
          />
          <circle className="logo-node node-left" cx="78" cy="62" r="31" />
          <circle className="logo-node node-mid" cx="130" cy="28" r="31" />
          <circle className="logo-node node-right" cx="182" cy="62" r="31" />
          <circle className="logo-hole node-left" cx="78" cy="62" r="12" />
          <circle className="logo-hole node-mid" cx="130" cy="28" r="12" />
          <circle className="logo-hole node-right" cx="182" cy="62" r="12" />
          <rect
            className="logo-face"
            x="77"
            y="176"
            width="106"
            height="86"
            rx="14"
            fill={`url(#${faceGradientId})`}
          />
          <rect className="socket socket-a" x="101" y="204" width="14" height="31" rx="3" />
          <rect className="socket socket-b" x="145" y="204" width="14" height="31" rx="3" />
          <path className="socket socket-c" d="M121 250c0-7 5-12 11-12s11 5 11 12v16h-22v-16Z" />
          <rect className="logo-sweep" x="128" y="0" width="132" height="330" />
        </svg>
      </motion.div>

      {showCopy && (
        <motion.div
          className="loadwise-copy"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.95, duration: 0.76, ease: [0.22, 1, 0.36, 1] }}
        >
          <p>LOADWISE</p>
          <span>Context-aware power management</span>
        </motion.div>
      )}

      {showProgress && (
        <div className="loader-progress" aria-hidden="true">
          <div />
        </div>
      )}
    </div>
  )
}
