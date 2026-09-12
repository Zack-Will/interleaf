import { expect } from 'chai'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import { PermissionsContext } from '@/features/ide-react/context/permissions-context'
import type { Permissions } from '@/features/ide-react/types/permissions'
import GithubBackupCard from '../../../../frontend/js/components/github-backup-card'

const PROJECT_ID = '63e21c07946dd8c76505f85a'
const STATUS_URL = `/project/${PROJECT_ID}/github-backup`

const owner: Permissions = {
  read: true,
  comment: true,
  resolveOwnComments: true,
  resolveAllComments: true,
  trackedWrite: true,
  write: true,
  admin: true,
  labelVersion: true,
}

const collaborator: Permissions = { ...owner, admin: false }

const linkedStatus = {
  linked: true,
  project_id: PROJECT_ID,
  owner: 'octocat',
  repo: 'thesis-backup',
  branch: 'main',
  repoUrl: 'https://github.com/octocat/thesis-backup',
  enabled: true,
  status: 'ok',
  lastSyncedVersion: 12,
  lastSyncedAt: '2026-09-12T10:00:00.000Z',
  lastPushedCommit: 'a'.repeat(40),
  lastError: null,
  inProgress: false,
}

function renderCard(permissions: Permissions) {
  render(
    <PermissionsContext.Provider value={permissions}>
      <GithubBackupCard />
    </PermissionsContext.Provider>
  )
}

async function openModal() {
  fireEvent.click(await screen.findByText('Back up to GitHub'))
  return screen.findByTestId('github-backup-modal')
}

describe('github-backup', function () {
  describe('<GithubBackupCard />', function () {
    beforeEach(function () {
      fetchMock.removeRoutes().clearHistory()
      window.metaAttributesCache.set('ol-project_id', PROJECT_ID)
      window.metaAttributesCache.set('ol-githubBackupEnabled', true)
    })

    afterEach(function () {
      fetchMock.removeRoutes().clearHistory()
    })

    it('renders nothing when the feature is disabled', function () {
      window.metaAttributesCache.set('ol-githubBackupEnabled', false)
      renderCard(owner)

      expect(screen.queryByText('Back up to GitHub')).to.be.null
    })

    it('offers the connect form to the owner of an unlinked project', async function () {
      fetchMock.get(STATUS_URL, { status: 200, body: { linked: false } })
      renderCard(owner)
      await openModal()

      await screen.findByTestId('github-backup-connect-form')
      screen.getByText('This project is not backed up to GitHub yet.')
      expect(
        (screen.getByLabelText('Branch') as HTMLInputElement).value
      ).to.equal('main')
      expect(
        (screen.getByLabelText('GitHub access token') as HTMLInputElement).type
      ).to.equal('password')
      screen.getByLabelText('Create the repository if it does not exist')
    })

    it('posts the repository, branch and token when connecting', async function () {
      fetchMock.get(STATUS_URL, { status: 200, body: { linked: false } })
      fetchMock.post(STATUS_URL, { status: 200, body: linkedStatus })
      renderCard(owner)
      await openModal()
      await screen.findByTestId('github-backup-connect-form')

      fireEvent.change(screen.getByLabelText('Repository'), {
        target: { value: 'octocat/thesis-backup' },
      })
      fireEvent.change(screen.getByLabelText('GitHub access token'), {
        target: { value: 'github_pat_secret' },
      })
      fireEvent.click(
        screen.getByLabelText('Create the repository if it does not exist')
      )
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      // The status GET and the connect POST share a URL, so the call history is
      // filtered by method.
      await waitFor(() =>
        expect(
          fetchMock.callHistory.calls(STATUS_URL, { method: 'POST' })
        ).to.have.length(1)
      )
      const { options } = fetchMock.callHistory.calls(STATUS_URL, {
        method: 'POST',
      })[0]
      expect(JSON.parse(String(options.body))).to.deep.equal({
        repository: 'octocat/thesis-backup',
        branch: 'main',
        token: 'github_pat_secret',
        createIfMissing: true,
      })
      await screen.findByText('octocat/thesis-backup')
    })

    it('tells a collaborator that only the owner can connect a repository', async function () {
      fetchMock.get(STATUS_URL, { status: 200, body: { linked: false } })
      renderCard(collaborator)
      await openModal()

      await screen.findByText(
        'Only the project owner can connect a GitHub repository.'
      )
      expect(screen.queryByTestId('github-backup-connect-form')).to.be.null
    })

    it('shows the repository, the branch and the backup state when linked', async function () {
      fetchMock.get(STATUS_URL, { status: 200, body: linkedStatus })
      renderCard(owner)
      await openModal()

      const repository = await screen.findByRole('link', {
        name: 'octocat/thesis-backup',
      })
      expect(repository.getAttribute('href')).to.equal(
        'https://github.com/octocat/thesis-backup'
      )
      screen.getByText('(main)')
      screen.getByText('Backed up')
      screen.getByText(/at version 12/)
      screen.getByRole('button', { name: 'Back up now' })
      screen.getByRole('button', { name: 'Disconnect' })
    })

    it('explains a diverged repository and keeps the disconnect behind a confirmation', async function () {
      fetchMock.get(STATUS_URL, {
        status: 200,
        body: {
          ...linkedStatus,
          status: 'diverged',
          lastError: {
            code: 'diverged',
            message: 'GitHub has commits that Overleaf does not have.',
            at: '2026-09-12T11:00:00.000Z',
          },
        },
      })
      fetchMock.delete(STATUS_URL, { status: 200, body: {} })
      renderCard(owner)
      await openModal()

      await screen.findByText('Diverged')
      screen.getByText('GitHub has commits that Overleaf does not have.')

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
      await screen.findByTestId('github-backup-disconnect-modal')
      expect(fetchMock.callHistory.called(STATUS_URL, { method: 'DELETE' })).to
        .be.false

      fireEvent.click(screen.getByTestId('github-backup-disconnect-confirm'))
      await waitFor(
        () =>
          expect(fetchMock.callHistory.called(STATUS_URL, { method: 'DELETE' }))
            .to.be.true
      )
    })

    it('asks the server for a backup when the user clicks Back up now', async function () {
      fetchMock.get(STATUS_URL, { status: 200, body: linkedStatus })
      fetchMock.post(`${STATUS_URL}/sync`, {
        status: 200,
        body: { ...linkedStatus, status: 'syncing', inProgress: true },
      })
      renderCard(owner)
      await openModal()

      fireEvent.click(
        await screen.findByRole('button', { name: 'Back up now' })
      )

      await waitFor(
        () =>
          expect(fetchMock.callHistory.called(`${STATUS_URL}/sync`)).to.be.true
      )
      await screen.findByText('Backing up')
    })

    it('surfaces a server error', async function () {
      fetchMock.get(STATUS_URL, { status: 200, body: { linked: false } })
      fetchMock.post(STATUS_URL, {
        status: 403,
        body: {
          code: 'github_no_push_permission',
          message: 'The GitHub token cannot push to this repository.',
        },
      })
      renderCard(owner)
      await openModal()
      await screen.findByTestId('github-backup-connect-form')

      fireEvent.change(screen.getByLabelText('Repository'), {
        target: { value: 'octocat/thesis-backup' },
      })
      fireEvent.change(screen.getByLabelText('GitHub access token'), {
        target: { value: 'github_pat_secret' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      await screen.findByText(
        'The GitHub token cannot push to this repository.'
      )
    })
  })
})
