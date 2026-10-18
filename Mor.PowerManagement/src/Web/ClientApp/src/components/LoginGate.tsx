import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, LockKeyhole, Mail, Radio, WifiOff } from 'lucide-react'
import { motion, useReducedMotion } from 'framer-motion'
import { login } from '../api'
import { LoadwiseBrand } from './LoadwiseBrand'

type LoginGateProps = {
  onAuthenticated: (email: string) => void
  onOffline: () => void
}

export function LoginGate({ onAuthenticated, onOffline }: LoginGateProps) {
  const [email, setEmail] = useState('administrator@localhost')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const reduceMotion = useReducedMotion()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(email, password)
      onAuthenticated(email)
    } catch {
      setError('Login failed. Check the credentials and that the backend is running.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-screen">
      <div className="login-glow login-glow-a" aria-hidden="true" />
      <div className="login-glow login-glow-b" aria-hidden="true" />
      <motion.section
        className="login-card"
        aria-label="Dashboard login"
        initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="login-brand">
          <LoadwiseBrand variant="login" />
          <div>
            <p className="login-eyebrow">MOR POWER</p>
            <p className="login-brand-name">Power Management</p>
          </div>
        </div>

        <div className="login-heading">
          <span className="login-access-icon"><Radio size={17} aria-hidden="true" /></span>
          <p>CONTROL CONSOLE</p>
          <h1>Sign in</h1>
          <span>Use your administrator account to continue.</span>
        </div>

        <form className="login-form" onSubmit={submit}>
          <label className="login-field">
            <span>Email address</span>
            <span className="login-input-wrap">
              <Mail size={17} aria-hidden="true" />
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="name@example.com"
                required
              />
            </span>
          </label>
          <label className="login-field">
            <span>Password</span>
            <span className="login-input-wrap">
              <LockKeyhole size={17} aria-hidden="true" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                required
              />
              <button
                className="login-password-toggle"
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((show) => !show)}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </span>
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="login-submit" type="submit" disabled={busy}>
            {busy ? <><span className="login-spinner" aria-hidden="true" /> Signing in…</> : 'Sign in'}
          </button>
        </form>

        <div className="login-divider"><span>OR</span></div>
        <button className="login-offline" type="button" onClick={onOffline}>
          <WifiOff size={16} aria-hidden="true" />
          Explore offline demo
        </button>
        <p className="login-footnote">Offline mode uses simulated readings.</p>
      </motion.section>
      <p className="login-footer">MOR POWER <span>·</span> POWER MANAGEMENT CONSOLE</p>
    </main>
  )
}
