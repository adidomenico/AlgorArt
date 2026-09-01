import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CampaignViewModel } from '../../lib/campaign'
import CampaignCard from './CampaignCard'

const campaign: CampaignViewModel = {
  id: 42n,
  creator: 'CREATORADDRESS',
  goalMicroAlgos: 10_000_000n,
  raisedMicroAlgos: 5_000_000n,
  deadlineSeconds: BigInt(Math.floor(Date.now() / 1000) + 86_400),
  status: 'open',
  myPledgeMicroAlgos: 1_000_000n,
}

describe('CampaignCard', () => {
  it('renders campaign id, status, raised, goal, and pledge', () => {
    render(<CampaignCard campaign={campaign} onSelect={() => {}} />)
    expect(screen.getByText('#42')).toBeInTheDocument()
    expect(screen.getByText('open')).toBeInTheDocument()
    expect(screen.getByText('5 ALGO')).toBeInTheDocument()
    expect(screen.getByText('10 ALGO')).toBeInTheDocument()
    expect(screen.getByText(/Your pledge: 1 ALGO/)).toBeInTheDocument()
  })

  it('calls onSelect with the campaign id when clicked', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<CampaignCard campaign={campaign} onSelect={onSelect} />)
    await user.click(screen.getByRole('button'))
    expect(onSelect).toHaveBeenCalledWith(42n)
  })

  it('hides the pledge line when the viewer has not pledged', () => {
    render(<CampaignCard campaign={{ ...campaign, myPledgeMicroAlgos: undefined }} onSelect={() => {}} />)
    expect(screen.queryByText(/Your pledge/)).not.toBeInTheDocument()
  })

  it('caps the progress bar at 100% when overfunded', () => {
    render(<CampaignCard campaign={{ ...campaign, goalMicroAlgos: 1_000_000n, raisedMicroAlgos: 5_000_000n }} onSelect={() => {}} />)
    const fill = document.querySelector('.campaign-card__progress-fill') as HTMLElement
    expect(fill.style.width).toBe('100%')
  })

  it('renders zero progress when the goal is zero', () => {
    render(<CampaignCard campaign={{ ...campaign, goalMicroAlgos: 0n, raisedMicroAlgos: 0n }} onSelect={() => {}} />)
    const fill = document.querySelector('.campaign-card__progress-fill') as HTMLElement
    expect(fill.style.width).toBe('0%')
  })
})
