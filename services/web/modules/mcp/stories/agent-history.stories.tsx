import HistoryVersion from '@/features/history/components/change-list/history-version'
import LabelListItem from '@/features/history/components/change-list/label-list-item'
import { HistoryProvider } from '@/features/history/context/history-context'
import { LoadedUpdate } from '@/features/history/services/types/update'
import { Label } from '@/features/history/services/types/label'
import { ScopeDecorator } from '../../../frontend/stories/decorators/scope'

// Keeps the fixtures readable: one timestamp per entry, newest first.
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-12T10:00:00.000Z')

const CURRENT_USER_ID = 'story-user'
const PROJECT_ID = '63e21c07946dd8c76505f85a'

const human = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  id: CURRENT_USER_ID,
}

function label(
  id: string,
  comment: string,
  version: number,
  createdAt: number
): Label {
  return {
    id,
    comment,
    version,
    user_id: CURRENT_USER_ID,
    user_display_name: 'Ada Lovelace',
    created_at: new Date(createdAt).toISOString(),
    lastUpdatedTimestamp: createdAt,
  }
}

// A plain edit made by a person in the editor: no origin, no label.
const humanEdit: LoadedUpdate = {
  fromV: 9,
  toV: 10,
  meta: {
    users: [human],
    start_ts: NOW,
    end_ts: NOW,
  },
  labels: [],
  pathnames: ['main.tex'],
  project_ops: [],
}

// An agent write through the MCP endpoint, by a client that named itself.
// The label comment is the message the agent passed to write_files.
const namedAgentWrite: LoadedUpdate = {
  fromV: 8,
  toV: 9,
  meta: {
    users: [human],
    start_ts: NOW - DAY,
    end_ts: NOW - DAY,
    origin: {
      kind: 'mcp',
      agent: 'Claude Code',
      message: 'Rewrite the abstract for clarity',
    },
  },
  labels: [
    label('label-mcp', 'Rewrite the abstract for clarity', 9, NOW - DAY),
  ],
  pathnames: ['main.tex', 'sections/abstract.tex'],
  project_ops: [],
}

// The same write from a client that did not report a name, or stored before
// the name was kept in history. It falls back to the generic wording.
const anonymousAgentWrite: LoadedUpdate = {
  fromV: 7,
  toV: 8,
  meta: {
    users: [human],
    start_ts: NOW - 2 * DAY,
    end_ts: NOW - 2 * DAY,
    origin: { kind: 'mcp' },
  },
  labels: [label('label-mcp-anon', 'Fix the bibliography', 8, NOW - 2 * DAY)],
  pathnames: ['references.bib'],
  project_ops: [],
}

// A push through the git-bridge. Same shape, different origin.
const gitPush: LoadedUpdate = {
  fromV: 6,
  toV: 7,
  meta: {
    users: [human],
    start_ts: NOW - 3 * DAY,
    end_ts: NOW - 3 * DAY,
    origin: { kind: 'git-bridge' },
  },
  labels: [
    label('label-git', 'Add figure 3 and its caption', 7, NOW - 3 * DAY),
  ],
  pathnames: ['figures/plot.tex'],
  project_ops: [{ add: { pathname: 'figures/plot.pdf' }, atV: 7 }],
}

// A revert, which our write service records as a normal forward version.
const projectRestore: LoadedUpdate = {
  fromV: 5,
  toV: 6,
  meta: {
    users: [human],
    start_ts: NOW - 4 * DAY,
    end_ts: NOW - 4 * DAY,
    origin: {
      kind: 'project-restore',
      timestamp: NOW - 5 * DAY,
      version: 5,
    },
  },
  labels: [],
  pathnames: [],
  project_ops: [],
}

const updates = [
  humanEdit,
  namedAgentWrite,
  anonymousAgentWrite,
  gitPush,
  projectRestore,
]

const noop = () => {}

const sharedProps = {
  currentUserId: CURRENT_USER_ID,
  projectId: PROJECT_ID,
  selectable: true,
  faded: false,
  selectionState: null,
  setSelection: noop,
  dropdownOpen: false,
  dropdownActive: false,
  compareDropdownOpen: false,
  compareDropdownActive: false,
  setActiveDropdownItem: noop,
  closeDropdownForItem: noop,
} as const

export const AllHistory = () => (
  <HistoryProvider>
    {updates.map((update, index) => (
      <HistoryVersion
        key={update.toV}
        {...sharedProps}
        update={update}
        showDivider={index > 0}
      />
    ))}
  </HistoryProvider>
)

export const LabelsOnly = () => (
  <HistoryProvider>
    {updates
      .filter(update => update.labels.length > 0)
      .map(update => (
        <LabelListItem
          key={update.toV}
          {...sharedProps}
          version={update.toV}
          labels={update.labels}
        />
      ))}
  </HistoryProvider>
)

export default {
  title: 'History / Agent and Git changes',
  component: HistoryVersion,
  decorators: [
    ScopeDecorator,
    (Story: React.ComponentType) => (
      <div className="history-react">
        <div className="change-list">
          <div className="history-version-list-container">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
}
