import { ErrorCode } from '../errors'
import { providerUpstreamError } from './errors'

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

export interface LinearComment {
  id: string
  body: string
  createdAt: string
  updatedAt: string
  user?: { id: string; name?: string | null; displayName?: string | null } | null
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
  comments?: {
    nodes: Array<{ id: string }>
    pageInfo?: { hasNextPage: boolean; endCursor: string | null }
  } | null
}

interface LinearCommentNode {
  id: string
  body: string
  createdAt: string
  updatedAt: string
  user?: { id: string; name?: string | null; displayName?: string | null } | null
}

function toLinearIssue(node: LinearIssueNode): LinearIssue {
  return {
    ...node,
    assignee: node.assignee
      ? {
          id: node.assignee.id,
          name: node.assignee.displayName || node.assignee.name,
        }
      : null,
    labels: node.labels?.nodes.map((label) => label.name) ?? [],
    commentCount: node.comments?.nodes?.length ?? undefined,
  }
}

const COMMENT_FIELDS = `
  id
  body
  createdAt
  updatedAt
  user { id name displayName }
`

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
                comments(first: 250) {
                  nodes { id }
                  pageInfo { hasNextPage endCursor }
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
      issues.push(...data.issues.nodes.map(toLinearIssue))
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
              comments(first: 250) {
                nodes { id }
                pageInfo { hasNextPage endCursor }
              }
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
      issue: node ? toLinearIssue(node) : null,
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
    issueId: string
    first?: number
    after?: string | null
  }): Promise<{
    nodes: Array<{
      id: string
      createdAt: string
      fromState?: { id: string } | null
      toState?: { id: string } | null
    }>
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }> {
    const data = await this.query<{
      issue: {
        history: {
          nodes: Array<{
            id: string
            createdAt: string
            fromState?: { id: string } | null
            toState?: { id: string } | null
          }>
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      } | null
    }>(
      `
        query IssueHistory($issueId: String!, $first: Int, $after: String) {
          issue(id: $issueId) {
            history(first: $first, after: $after) {
              nodes {
                id
                createdAt
                fromState { id }
                toState { id }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      {
        issueId: params.issueId,
        first: params.first ?? 50,
        after: params.after ?? null,
      },
    )
    if (!data.issue) {
      return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
    }
    return data.issue.history
  }

  async getIssueTeam(issueId: string): Promise<{ id: string; key: string } | null> {
    const data = await this.query<{
      issue: {
        team: {
          id: string
          key: string
        } | null
      } | null
    }>(
      `
        query IssueTeam($issueId: String!) {
          issue(id: $issueId) {
            team {
              id
              key
            }
          }
        }
      `,
      { issueId },
    )

    return data.issue?.team ?? null
  }

  async listComments(issueId: string): Promise<LinearComment[]> {
    let after: string | null = null
    const comments: LinearComment[] = []

    do {
      const data: {
        issue: {
          comments: {
            nodes: LinearCommentNode[]
            pageInfo: PageInfo
          }
        } | null
      } = await this.query(
        `
          query IssueComments($issueId: String!, $after: String) {
            issue(id: $issueId) {
              comments(first: 100, after: $after) {
                nodes { ${COMMENT_FIELDS} }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        { issueId, after },
      )
      if (!data.issue) {
        providerUpstreamError(`Linear issue '${issueId}' was not found`)
      }
      comments.push(...data.issue.comments.nodes)
      after = data.issue.comments.pageInfo.hasNextPage
        ? data.issue.comments.pageInfo.endCursor
        : null
    } while (after)

    return comments
  }

  async getComment(commentId: string): Promise<LinearComment> {
    const data = await this.query<{ comment: LinearCommentNode | null }>(
      `
        query Comment($id: String!) {
          comment(id: $id) { ${COMMENT_FIELDS} }
        }
      `,
      { id: commentId },
    )
    if (!data.comment) {
      providerUpstreamError(`Linear comment '${commentId}' was not found`)
    }
    return data.comment
  }

  async commentCreate(
    issueId: string,
    body: string,
  ): Promise<{ success: boolean; comment: LinearComment | null }> {
    const data = await this.query<{
      commentCreate: { success: boolean; comment: LinearCommentNode | null }
    }>(
      `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment { ${COMMENT_FIELDS} }
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
    return {
      success: data.commentCreate.success,
      comment: data.commentCreate.comment,
    }
  }

  async commentUpdate(
    commentId: string,
    body: string,
  ): Promise<{ success: boolean; comment: LinearComment | null }> {
    const data = await this.query<{
      commentUpdate: { success: boolean; comment: LinearCommentNode | null }
    }>(
      `
        mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
          commentUpdate(id: $id, input: $input) {
            success
            comment { ${COMMENT_FIELDS} }
          }
        }
      `,
      {
        id: commentId,
        input: {
          body,
        },
      },
    )
    return {
      success: data.commentUpdate.success,
      comment: data.commentUpdate.comment,
    }
  }
}
