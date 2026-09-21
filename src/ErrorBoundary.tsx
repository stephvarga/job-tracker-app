import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Without this, any render-time throw leaves a blank white page: on a shop
 * floor that's indistinguishable from "the app ate my hours", which is exactly
 * the confusion this codebase has already paid for once.
 *
 * Shows the error and a reload button instead. Tracked time lives in Postgres,
 * not in component state, so reloading loses nothing.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Shop Timer crashed:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        style={{
          // Keeps its own background deliberately: this screen has to render
          // correctly even if the stylesheet is what failed.
          minHeight: '100dvh',
          background: '#0D0805',
          color: '#E8E8D0',
          padding: '48px 24px',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
        }}
        role="alert"
      >
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <h1 style={{ color: '#1BC8D4', fontSize: '1.5rem' }}>Something broke</h1>
          <p style={{ color: '#F2C14A' }}>
            Your tracked time is safe, it's stored on the server, not in this page.
          </p>
          <pre
            style={{
              background: '#1A0D2E',
              border: '1px solid #C44A1A',
              borderRadius: 8,
              padding: 12,
              overflow: 'auto',
              fontSize: '0.8125rem',
              whiteSpace: 'pre-wrap'
            }}
          >
            {error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#1A0D2E',
              border: '1px solid #F2C14A',
              color: '#F2C14A',
              padding: '8px 18px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: '0.9375rem'
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
