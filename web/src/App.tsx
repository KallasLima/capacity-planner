import { CapacityGrid } from './CapacityGrid'

// Use a fixed window that exposes the supplied seed's golden allocation cases.
export function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <a href="/" className="brand" aria-label="Capacity home">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span>
            capacity<span className="brand-period">.</span>
          </span>
        </a>
        <span className="header-divider" />
        <span className="workspace-name">Demo workspace</span>
        <span className="header-label">
          <span />
          Planning workspace
        </span>
      </header>
      <main>
        <CapacityGrid from="2025-12-29" to="2026-02-08" />
      </main>
    </div>
  )
}
