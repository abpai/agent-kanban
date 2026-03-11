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
    setFilterAssignee,
    setFilterProject,
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

  return (
    <div className="header">
      <div className="headerTop">
        <h1>
          <span>agent</span>-kanban
          <span style={{ marginLeft: 8 }}>
            <span
              className={`wsIndicator ${wsConnected ? 'connected' : 'disconnected'}`}
              title={wsConnected ? 'Live' : 'Polling'}
            />
          </span>
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {provider === 'linear' && team ? `${team.name} (${team.key})` : provider}
          </div>
          {capabilities.taskCreate && (
            <button className="newTaskBtn" onClick={() => setShowNewTaskModal(true)}>
              + New Task
            </button>
          )}
        </div>
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
        <div className="filterGroup">
          <button
            className={`filterBtn${filterAssignee === null ? ' active' : ''}`}
            onClick={() => setFilterAssignee(null)}
          >
            All
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
        <div className="filterGroup">
          <select
            className="projectDropdown"
            value={filterProject ?? ''}
            onChange={(e) => setFilterProject(e.target.value || null)}
          >
            <option value="">All Projects</option>
            {allProjects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}
