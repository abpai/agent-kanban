import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { getTaskOptions } from '../utils'
import { parseActivityDays } from '../store/ui-slice'

export function Header() {
  const {
    metrics,
    config,
    provider,
    team,
    canCreate,
    filterAssignee,
    filterProject,
    filterActivityDays,
    searchQuery,
    setFilterAssignee,
    setFilterProject,
    setFilterActivityDays,
    setSearchQuery,
    setShowNewTaskModal,
    wsConnected,
  } = useStore(
    useShallow((s) => ({
      metrics: s.metrics,
      config: s.config,
      provider: s.provider,
      team: s.team,
      canCreate: s.capabilities.taskCreate,
      filterAssignee: s.filterAssignee,
      filterProject: s.filterProject,
      filterActivityDays: s.filterActivityDays,
      searchQuery: s.searchQuery,
      setFilterAssignee: s.setFilterAssignee,
      setFilterProject: s.setFilterProject,
      setFilterActivityDays: s.setFilterActivityDays,
      setSearchQuery: s.setSearchQuery,
      setShowNewTaskModal: s.setShowNewTaskModal,
      wsConnected: s.wsConnected,
    })),
  )
  const options = getTaskOptions(metrics, config)
  const assignees = [
    ...new Set([...options.assignees, ...(filterAssignee ? [filterAssignee] : [])]),
  ].sort()
  const projects = [
    ...new Set([...options.projects, ...(filterProject ? [filterProject] : [])]),
  ].sort()
  const providerLabel = team
    ? `${team.name} (${team.key})`
    : provider === 'local'
      ? 'Local board'
      : provider
  const hasFilters = filterAssignee || filterProject || filterActivityDays || searchQuery

  return (
    <header className="header">
      <div className="headerTop">
        <div className="headerIdentity">
          <h1>
            agent<span className="brandSeparator">/</span>kanban
          </h1>
          <span className="providerBadge">{providerLabel}</span>
        </div>
        <div className="headerActions">
          <span
            className="liveStatus"
            title={
              wsConnected ? 'Changes appear automatically' : 'Checking for changes every 5 seconds'
            }
          >
            <span className={`wsIndicator ${wsConnected ? 'connected' : ''}`} />
            {wsConnected ? 'Live' : 'Polling'}
          </span>
          {canCreate && (
            <button className="btnPrimary" onClick={() => setShowNewTaskModal(true)}>
              + New task
            </button>
          )}
        </div>
      </div>
      <div className="boardHeading">
        <h2>Board</h2>
        {metrics && (
          <p className="boardSummary">
            <strong>{metrics.totalTasks}</strong> tasks<span aria-hidden="true"> · </span>
            <strong>{metrics.inProgressCount}</strong> in progress
            <span aria-hidden="true"> · </span>
            {metrics.completionPercent}% complete
          </p>
        )}
      </div>
      <div className="filterBar" role="search" aria-label="Filter tasks">
        <input
          className="searchInput"
          type="search"
          aria-label="Search tasks"
          placeholder="Search tasks…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <select
          className="filterSelect"
          aria-label="Filter by assignee"
          value={filterAssignee ?? ''}
          onChange={(e) => setFilterAssignee(e.target.value || null)}
        >
          <option value="">Everyone</option>
          {assignees.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="filterSelect"
          aria-label="Filter by project"
          value={filterProject ?? ''}
          onChange={(e) => setFilterProject(e.target.value || null)}
        >
          <option value="">All projects</option>
          {projects.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="filterSelect"
          aria-label="Filter by activity"
          value={filterActivityDays ?? ''}
          onChange={(e) => setFilterActivityDays(parseActivityDays(e.target.value))}
        >
          <option value="">Any activity</option>
          <option value="1">Active in 24h</option>
          <option value="7">Active in 7 days</option>
          <option value="14">Active in 14 days</option>
          <option value="28">Active in 28 days</option>
          <option value="70">Active in 70 days</option>
        </select>
        {hasFilters && (
          <button
            className="filterReset"
            onClick={() => {
              setFilterAssignee(null)
              setFilterProject(null)
              setFilterActivityDays(null)
              setSearchQuery('')
            }}
          >
            Clear filters
          </button>
        )}
      </div>
    </header>
  )
}
