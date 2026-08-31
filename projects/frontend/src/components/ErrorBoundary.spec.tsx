import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'

describe('ErrorBoundary', () => {
  // React's DEV error-boundary machinery re-reports deliberately thrown errors
  // through jsdom's `window` error event (bypassing `console.error`, so a
  // console spy can't silence it). Marking the event as handled prevents jsdom
  // from printing noisy "uncaught" stack traces while the boundary still
  // catches the error and renders the fallback.
  let cleanup: () => void

  beforeEach(() => {
    const handler = (event: ErrorEvent) => event.preventDefault()
    window.addEventListener('error', handler)
    cleanup = () => window.removeEventListener('error', handler)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div>healthy child</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('healthy child')).toBeInTheDocument()
  })

  it('renders a fallback and the config hint for algod config errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    function ConfigBomb(): JSX.Element {
      throw new Error('Attempt to get default algod configuration without specifying VITE_ALGOD_SERVER')
    }
    render(
      <ErrorBoundary>
        <ConfigBomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Error occured')).toBeInTheDocument()
    expect(screen.getByText(/Please make sure to set up your environment variables/)).toBeInTheDocument()
    spy.mockRestore()
  })

  it('renders the raw error message for other errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    function OtherBomb(): JSX.Element {
      throw new Error('custom failure')
    }
    render(
      <ErrorBoundary>
        <OtherBomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('custom failure')).toBeInTheDocument()
    spy.mockRestore()
  })
})
