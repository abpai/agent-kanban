import { ErrorCode } from '../errors.ts'
import { providerUpstreamError } from './errors.ts'

interface GraphQLResponse<T> {
  data?: T
  errors?: Array<{ message?: string; extensions?: { code?: string } }>
}

interface PageInfo {
  hasNextPage: boolean
  endCursor: string | null
}

export interface LinearTeamState {
  id: string
  name: string
  position: number
  color?: string | null
  type?: string | null
}

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  description?: string | null
  priority?: number | null
  url?: string | null
  createdAt: string
  updatedAt: string
  assignee?: { id: string; name?: string | null; displayName?: string | null } | null
  project?: { id: string; name: string; url?: string | null; state?: string | null } | null
  state: { id: string; name: string; position: number }
  labels?: string[]
  commentCount?: number
}

interface LinearIssueNode {
  id: string
  identifier: string
  title: string
  description?: string | null
  priority?: number | null
  url?: string | null
  createdAt: string
  updatedAt: string
  assignee?: { id: string; name?: string | null; displayName?: string | null } | null
  project?: { id: string; name: string; url?: string | null; state?: string | null } | null
  state: { id: string; name: string; position: number }
  labels?: { nodes: Array<{ id: string; name: string }> }
}

export class LinearClient {
  private readonly endpoint = 'https://api.linear.app/graphql'

  constructor(private readonly apiKey: string) {}

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    })

    if (response.status === 401 || response.status === 403) {
      providerUpstreamError('Linear authentication failed', ErrorCode.PROVIDER_AUTH_FAILED)
    }

    if (response.status === 429) {
      providerUpstreamError('Linear API rate limit exceeded', ErrorCode.PROVIDER_RATE_LIMITED)
    }

    if (!response.ok) {
      providerUpstreamError(`Linear API request failed with ${response.status}`)
    }

    const body = (await response.json()) as GraphQLResponse<T>
    if (body.errors?.length) {
      const first = body.errors[0]
      if (first?.extensions?.code === 'RATELIMITED') {
        providerUpstreamError('Linear API rate limit exceeded', ErrorCode.PROVIDER_RATE_LIMITED)
      }
      providerUpstreamError(first?.message ?? 'Linear API request failed')
    }

    if (!body.data) {
      providerUpstreamError('Linear API returned no data')
    }

    return body.data
  }

  async getTeam(
    teamId: string,
  ): Promise<{ id: string; key: string; name: string; states: LinearTeamState[] }> {
    const data = await this.query<{
      team: {
        id: string
        key: string
        name: string
        states: { nodes: LinearTeamState[] }
      } | null
    }>(
      `
        query TeamSnapshot($teamId: String!) {
          team(id: $teamId) {
            id
            key
            name
            states {
              nodes {
                id
                name
                position
                color
                type
              }
            }
          }
        }
      `,
      { teamId },
    )
    if (!data.team) {
      providerUpstreamError(`Linear team '${teamId}' was not found`)
    }
    return {
      id: data.team.id,
      key: data.team.key,
      name: data.team.name,
      states: data.team.states.nodes,
    }
  }

  async listUsers(): Promise<Array<{ id: string; name: string; active?: boolean }>> {
    const data = await this.query<{
      users: {
        nodes: Array<{
          id: string
          name?: string | null
          displayName?: string | null
          active?: boolean | null
        }>
      }
    }>(
      `
        query Users {
          users {
            nodes {
              id
              name
              displayName
              active
            }
          }
        }
      `,
    )
    return data.users.nodes.map((user) => ({
      id: user.id,
      name: user.displayName || user.name || user.id,
      active: user.active ?? true,
    }))
  }

  async listProjects(): Promise<
    Array<{ id: string; name: string; url?: string | null; state?: string | null }>
  > {
    const data = await this.query<{
      projects: {
        nodes: Array<{ id: string; name: string; url?: string | null; state?: string | null }>
      }
    }>(
      `
        query Projects {
          projects {
            nodes {
              id
              name
              url
              state
            }
          }
        }
      `,
    )
    return data.projects.nodes
  }

  async listIssues(teamId: string, updatedAfter?: string): Promise<LinearIssue[]> {
    let after: string | null = null
    const issues: LinearIssue[] = []

    do {
      const data: {
        issues: {
          nodes: LinearIssueNode[]
          pageInfo: PageInfo
        }
      } = await this.query(
        `
          query Issues($teamId: ID!, $after: String, $updatedAfter: DateTimeOrDuration) {
            issues(
              first: 100
              after: $after
              orderBy: updatedAt
              filter: {
                team: { id: { eq: $teamId } }
                updatedAt: { gte: $updatedAfter }
              }
            ) {
              nodes {
                id
                identifier
                title
                description
                priority
                url
                createdAt
                updatedAt
                assignee {
                  id
                  name
                  displayName
                }
                project {
                  id
                  name
                  url
                  state
                }
                state {
                  id
                  name
                  position
                }
                labels {
                  nodes { id name }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { teamId, after, updatedAfter: updatedAfter ?? '1970-01-01T00:00:00.000Z' },
      )
      issues.push(
        ...data.issues.nodes.map((issue: LinearIssueNode) => ({
          ...issue,
          assignee: issue.assignee
            ? {
                id: issue.assignee.id,
                name: issue.assignee.displayName || issue.assignee.name,
              }
            : null,
          labels: issue.labels?.nodes.map((l) => l.name) ?? [],
          commentCount: 0,
        })),
      )
      after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null
    } while (after)

    return issues
  }

  async createIssue(input: {
    teamId: string
    stateId?: string
    title: string
    description?: string
    priority?: number
    assigneeId?: string
    projectId?: string
  }): Promise<{ success: boolean; issue: LinearIssue | null }> {
    const data = await this.query<{
      issueCreate: { success: boolean; issue: LinearIssueNode | null }
    }>(
      `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              identifier
              title
              description
              priority
              url
              createdAt
              updatedAt
              assignee { id name displayName }
              project { id name url state }
              state { id name position }
              labels { nodes { id name } }
            }
          }
        }
      `,
      {
        input: {
          teamId: input.teamId,
          stateId: input.stateId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          assigneeId: input.assigneeId,
          projectId: input.projectId,
        },
      },
    )
    const node = data.issueCreate.issue
    return {
      success: data.issueCreate.success,
      issue: node
        ? {
            ...node,
            labels: node.labels?.nodes.map((l) => l.name) ?? [],
            commentCount: 0,
          }
        : null,
    }
  }

  async updateIssue(
    issueId: string,
    input: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const data = await this.query<{
      issueUpdate: { success: boolean }
    }>(
      `
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
          }
        }
      `,
      { id: issueId, input },
    )
    return data.issueUpdate
  }

  async listIssueHistory(params: {
    teamId: string
    updatedAtGte: string
    first?: number
    after?: string | null
  }): Promise<{
    nodes: Array<{
      id: string
      createdAt: string
      issue: { id: string } | null
      fromState?: { id: string } | null
      toState?: { id: string } | null
    }>
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }> {
    const data = await this.query<{
      issueHistory: {
        nodes: Array<{
          id: string
          createdAt: string
          issue: { id: string } | null
          fromState?: { id: string } | null
          toState?: { id: string } | null
        }>
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    }>(
      `
        query IssueHistoryDelta($filter: IssueHistoryFilter!, $first: Int, $after: String) {
          issueHistory(filter: $filter, first: $first, after: $after) {
            nodes {
              id
              createdAt
              issue { id }
              fromState { id }
              toState { id }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      {
        filter: {
          issue: { team: { id: { eq: params.teamId } } },
          updatedAt: { gte: params.updatedAtGte },
        },
        first: params.first ?? 100,
        after: params.after ?? null,
      },
    )
    return data.issueHistory
  }

  async commentCreate(issueId: string, body: string): Promise<{ success: boolean }> {
    const data = await this.query<{
      commentCreate: { success: boolean }
    }>(
      `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
          }
        }
      `,
      {
        input: {
          issueId,
          body,
        },
      },
    )
    return data.commentCreate
  }
}
