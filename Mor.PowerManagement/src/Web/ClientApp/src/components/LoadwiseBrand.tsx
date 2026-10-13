import { motion } from 'framer-motion'

type LoadwiseBrandProps = {
  variant: 'intro' | 'header'
  showCopy?: boolean
  showProgress?: boolean
}

/**
 * The console mark.
 *
 * Redrawn on the Precision Instrumentation palette rather than the previous
 * gradient blue: the mark now shares its accent with the primary button and
 * the top-bar chip, so the identity and the interface are visibly the same
 * system. The socket face stays white and the antenna nodes stay one tone —
 * an instrument mark should have exactly as many values as a readout does.
 */
export function LoadwiseBrand({
  variant,
  showCopy = false,
  showProgress = false,
}: LoadwiseBrandProps) {
  return (
    <div className={`loadwise-brand ${variant}`}>
      <motion.div
        className="loadwise-mark"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      >
        <svg viewBox="0 0 260 330" role="img" aria-label="MOR Power mark">
          {/* Antenna nodes, drawn first so the body overlaps them. */}
          <circle className="logo-node node-left" cx="78" cy="62" r="26" />
          <circle className="logo-node node-mid" cx="130" cy="28" r="26" />
          <circle className="logo-node node-right" cx="182" cy="62" r="26" />
          <rect className="logo-neck neck-left" x="74" y="70" width="8" height="74" rx="4" />
          <rect className="logo-neck neck-mid" x="126" y="38" width="8" height="106" rx="4" />
          <rect className="logo-neck neck-right" x="178" y="70" width="8" height="74" rx="4" />

          {/* Body. */}
          <path
            className="logo-body"
            d="M40 142h153l33 33v70c0 11-6 21-15 27l-58 42c-13 9-31 9-44 0l-58-42c-9-6-15-16-15-27v-99c0-8 6-14 14-14Z"
            fill="#2B5A8F"
          />
          <path className="logo-corner" d="M192 142h1l33 33-40 40v-55c0-10 6-18 6-18Z" />
          <rect className="logo-slot" x="58" y="156" width="148" height="10" rx="5" />

          {/* Socket face: the one white surface in the mark. */}
          <rect className="logo-face" x="77" y="176" width="106" height="86" rx="14" />
          <rect className="socket socket-a" x="101" y="204" width="13" height="30" rx="2" />
          <rect className="socket socket-b" x="146" y="204" width="13" height="30" rx="2" />
          <path className="socket socket-c" d="M121 250c0-7 5-12 11-12s11 5 11 12v16h-22v-16Z" />
        </svg>
      </motion.div>

      {showCopy && (
        <motion.div
          className="loadwise-copy"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
        >
          <p>MOR Power</p>
          <span>Power Operations Console</span>
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