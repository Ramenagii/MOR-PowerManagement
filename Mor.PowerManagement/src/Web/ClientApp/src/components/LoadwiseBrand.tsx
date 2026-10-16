import { motion, useReducedMotion } from 'framer-motion'
import { PowerShieldMark } from './PowerShieldMark'

type LoadwiseBrandProps = {
  variant: 'intro' | 'header' | 'login'
  showCopy?: boolean
  showProgress?: boolean
}

/** MOR Power shield logo and wordmark. */
export function LoadwiseBrand({
  variant,
  showCopy = false,
  showProgress = false,
}: LoadwiseBrandProps) {
  const reduceMotion = useReducedMotion()
  return (
    <div className={`loadwise-brand ${variant}`}>
      <motion.div
        className="loadwise-mark"
        initial={variant === 'login' ? { opacity: 0, y: 10, scale: 0.9 } : { opacity: 0 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reduceMotion ? 0 : variant === 'login' ? 0.55 : 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <PowerShieldMark className="mor-power-mark" />
      </motion.div>

      {showCopy && (
        <motion.div
          className="loadwise-copy"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
        >
          <p>MOR Power</p>
          <span>Power Management Console</span>
        </motion.div>
      )}

      {variant === 'intro' && (
        <div className="intro-load-path" aria-hidden="true">
          <div className="intro-channels"><i /><i /><i /><i /></div>
          <div className="intro-bus" />
          <div className="intro-readout"><span /></div>
          <div className="intro-load-labels"><span>4 AC branches</span><span>DC monitor</span></div>
        </div>
      )}

      {showProgress && (
        <div className="loader-progress" aria-hidden="true"><div /></div>
      )}
    </div>
  )
}
