import type React from 'react'

export function HelpTip({ children }: { children: React.ReactNode }) {
  return (
    <span className="helptip">
      <span className="helptip-icon" aria-hidden>
        ?
      </span>
      <span className="helptip-content" role="tooltip">
        {children}
      </span>
    </span>
  )
}
