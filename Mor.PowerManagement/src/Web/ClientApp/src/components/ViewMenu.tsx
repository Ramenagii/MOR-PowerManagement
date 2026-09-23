import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Cpu, LayoutDashboard, SlidersHorizontal } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { AppView } from '../types/dashboard'

const menuItems: Array<{
  id: AppView
  label: string
  icon: ReactNode
}> = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={16} /> },
  { id: 'policies', label: 'Policies', icon: <SlidersHorizontal size={16} /> },
  { id: 'hardware', label: 'Hardware Components', icon: <Cpu size={16} /> },
]

type ViewMenuProps = {
  activeView: AppView
  onChange: (view: AppView) => void
}

export function ViewMenu({ activeView, onChange }: ViewMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const prefersReducedMotion = useReducedMotion()
  const activeLabel = menuItems.find((item) => item.id === activeView)?.label ?? 'Dashboard'

  const selectView = (view: AppView) => {
    onChange(view)
    setIsOpen(false)
  }

  return (
    <nav className={`view-menu ${isOpen ? 'open' : ''}`} aria-label="Loadwise sections">
      <div className="menu-current">
        <span>Menu</span>
        <strong>{activeLabel}</strong>
      </div>
      <button
        type="button"
        className="hamburger-button"
        aria-label={isOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={isOpen}
        aria-controls="loadwise-menu-panel"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span />
        <span />
        <span />
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="menu-panel"
            id="loadwise-menu-panel"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            {menuItems.map((item, index) => (
              <motion.button
                key={item.id}
                type="button"
                className={activeView === item.id ? 'active' : ''}
                aria-current={activeView === item.id ? 'page' : undefined}
                onClick={() => selectView(item.id)}
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 8 }}
                transition={{ duration: 0.22, delay: index * 0.035, ease: [0.22, 1, 0.36, 1] }}
              >
                {activeView === item.id && (
                  <motion.span
                    className="menu-active-pill"
                    layoutId="loadwise-active-menu-pill"
                    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  />
                )}
                <span className="menu-item-content">
                  {item.icon}
                  {item.label}
                </span>
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  )
}
