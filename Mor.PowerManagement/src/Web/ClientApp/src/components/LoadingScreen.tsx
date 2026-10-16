import { motion, useReducedMotion } from 'framer-motion'
import { LoadwiseBrand } from './LoadwiseBrand'

export function LoadingScreen() {
  const prefersReducedMotion = useReducedMotion()
  return (
    <motion.section
      className="loading-screen"
      aria-label="Loading dashboard"
      initial={{ opacity: 1, scale: 1 }}
      exit={{
        opacity: prefersReducedMotion ? 1 : 0,
        scale: 1,
        transition: { duration: prefersReducedMotion ? 0 : 0.72, ease: [0.22, 1, 0.36, 1] },
      }}
    >
      <div className="loader-noise" />
      <LoadwiseBrand variant="intro" showCopy showProgress />
    </motion.section>
  )
}
