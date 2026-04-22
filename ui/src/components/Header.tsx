import { useStore } from '../store'

export function Header() {
  const {
    metrics,
    config,
    provider,
    team,
    capabilities,
    filterAssignee,
    filterProject,
    filterActivityDays,
    setFilterAssignee,
    setFilterProject,
    setFilterActivityDays,
    setShowNewTaskModal,
    wsConnected,
  } = useStore()

  // Merge assignees from metrics + config members
  const metricAssignees = metrics?.assignees ?? []
  const configMembers = config?.members?.map((m) => m.name) ?? []
  const allAssignees = [...new Set([...metricAssignees, ...configMembers])].sort()

  // Merge projects from metrics + config
  const metricProjects = metrics?.projects ?? []
  const configProjects = config?.projects ?? []
  const allProjects = [...new Set([...metricProjects, ...configProjects])].sort()

  const providerLabel =
    team && (provider === 'linear' || provider === 'jira')
      ? `${team.name} (${team.key})`
      : provider === 'jira'
        ? 'Jira'
        : provider
  const hasActiveFilters =
    filterAssignee !== null || filterProject !== null || filterActivityDays !== null

  const resetFilters = () => {
    setFilterAssignee(null)
    setFilterProject(null)
    setFilterActivityDays(null)
  }

  return (
    <div className="header">
      <div className="headerTop">
        <div className="headerIdentity">
          <div className="headerTitleRow">
            <h1>
              <span>agent</span>-kanban
            </h1>
            <div
              className="liveStatus"
              title={wsConnected ? 'Live updates enabled' : 'Polling for updates'}
            >
              <span className={`wsIndicator ${wsConnected ? 'connected' : 'disconnected'}`} />
              <span>{wsConnected ? 'Live' : 'Polling'}</span>
            </div>
          </div>
          <div className="providerBadge">{providerLabel}</div>
        </div>

        {capabilities.taskCreate && (
          <button className="newTaskBtn" onClick={() => setShowNewTaskModal(true)}>
            + New Task
          </button>
        )}
      </div>

      {metrics && (
        <div className="statsBar">
          <div className="statCard">
            <span className="statValue">{metrics.tasksCreatedThisWeek}</span>
            <span className="statLabel">This week</span>
          </div>
          <div className="statCard">
            <span className="statValue">{metrics.inProgressCount}</span>
            <span className="statLabel">In progress</span>
          </div>
          <div className="statCard">
            <span className="statValue">{metrics.totalTasks}</span>
            <span className="statLabel">Total</span>
          </div>
          <div className="statCard">
            <span className="statValue">{metrics.completionPercent}%</span>
            <span className="statLabel">Completion</span>
          </div>
        </div>
      )}

      <div className="filterBar">
        <div className="filterLabel">Filter</div>
        <div className="filterRow">
          <div className="filterGroup filterScroller">
            <button
              key="all-assignees"
              className={`filterBtn${filterAssignee === null ? ' active' : ''}`}
              onClick={() => setFilterAssignee(null)}
            >
              Everyone
            </button>
            {allAssignees.map((name) => (
              <button
                key={name}
                className={`filterBtn${filterAssignee === name ? ' active' : ''}`}
                onClick={() => setFilterAssignee(filterAssignee === name ? null : name)}
              >
                {name}
              </button>
            ))}
          </div>
          <span className="filterDivider" aria-hidden="true" />
          <select
            className={`filterSelect${filterActivityDays !== null ? ' active' : ''}`}
            value={filterActivityDays ?? ''}
            onChange={(e) => {
              const value = e.target.value
              setFilterActivityDays(value ? (Number(value) as 1 | 7 | 14 | 28 | 70) : null)
            }}
          >
            <option value="">Any activity</option>
            <option value="1">Active in 24h</option>
            <option value="7">Active in 7d</option>
            <option value="14">Active in 14d</option>
            <option value="28">Active in 28d</option>
            <option value="70">Active in 70d</option>
          </select>
          <select
            className={`filterSelect${filterProject !== null ? ' active' : ''}`}
            value={filterProject ?? ''}
            onChange={(e) => setFilterProject(e.target.value || null)}
          >
            <option value="">All projects</option>
            {allProjects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {hasActiveFilters && (
            <button className="filterReset" onClick={resetFilters} type="button">
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
