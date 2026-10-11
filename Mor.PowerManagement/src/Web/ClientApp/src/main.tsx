import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
// Imported after the legacy stylesheet on purpose: the Ant token layer is the
// new standard and must win any conflict while the old views are being ported.
import './ant.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
