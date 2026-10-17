import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Footer from './Footer'

describe('Footer', () => {
  it('renders the brand and year', () => {
    render(<Footer />)
    expect(screen.getByText('kasakame 2026')).toBeInTheDocument()
  })
})
