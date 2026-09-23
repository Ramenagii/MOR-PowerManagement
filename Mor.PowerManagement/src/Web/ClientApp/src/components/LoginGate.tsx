import { useState, type FormEvent } from 'react'
import { login } from '../api'
import { LoadwiseBrand } from './LoadwiseBrand'

type LoginGateProps = {
  onAuthenticated: () => void
  onOffline: () => void
}

export function LoginGate({ onAuthenticated, onOffline }: LoginGateProps) {
  const [email, setEmail] = useState('administrator@localhost')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(email, password)
      onAuthenticated()
    } catch {
      setError('Login failed. Check the credentials and that the backend is running.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app-shell is-ready">
      <section className="panel" aria-label="Dashboard login" style={{ maxWidth: 420, margin: '12vh auto' }}>
        <LoadwiseBrand variant="header" />
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Power Management Console</p>
            <h2>Sign in</h2>
          </div>
        </div>
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button type="button" onClick={onOffline}>
            Continue offline (simulated)
          </button>
        </form>
      </section>
    </main>
  )
}
