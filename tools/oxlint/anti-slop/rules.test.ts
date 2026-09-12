import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import policy from '../../../.oxlintrc.json'

const hardRuleNames = [
  'no-chained-type-assertions',
  'no-known-value-widening',
  'no-object-parameters',
  'no-reflect-apply',
  'no-reflect-get',
  'no-unknown-parameters',
  'no-unknown-returns',
  'no-unknown-type-aliases',
  'no-unsafe-dictionary-type',
  'no-widen-then-assert',
  'require-safety-comment-for-type-assertion',
] as const

const directionalRuleNames = [
  'no-conditional-empty-object-spread',
  'no-module-mocking',
  'no-runtime-typeof',
  'no-shape-in-symbol-names',
] as const

const ruleNames = [...hardRuleNames, ...directionalRuleNames]

// Fixture directories that exercise policy behavior rather than one plugin rule.
const policyFixtureNames = ['complexity', 'suppressions'] as const

interface Diagnostic {
  // Absent for unused-directive reports, which carry no rule code.
  readonly code?: string
  readonly filename: string
  readonly message: string
  readonly severity: 'error' | 'warning'
}

interface OxlintReport {
  readonly diagnostics: readonly Diagnostic[]
  readonly number_of_files: number
  readonly number_of_rules: number
}

const repositoryRoot = join(import.meta.dir, '../../..')
const fixturesDirectory = join(import.meta.dir, '__fixtures__')
const configPath = join(import.meta.dir, 'fixtures.config.ts')
const oxlintPath = join(repositoryRoot, 'node_modules/.bin/oxlint')

const result = Bun.spawnSync({
  cmd: [process.execPath, oxlintPath, '--config', configPath, '--format', 'json', fixturesDirectory],
  cwd: repositoryRoot,
  stderr: 'pipe',
  stdout: 'pipe',
})

const stdout = result.stdout.toString()
const stderr = result.stderr.toString()

if (stdout.length === 0) {
  throw new Error(`Oxlint fixture run produced no JSON output. ${stderr}`)
}

const report = JSON.parse(stdout) as OxlintReport

function fixtureDiagnostics(fixtureDirectory: string, fixtureName: 'invalid' | 'valid') {
  const suffix = [fixtureDirectory, `${fixtureName}.fixture.ts`].join('/')
  return report.diagnostics.filter((diagnostic) =>
    diagnostic.filename.replaceAll('\\', '/').endsWith(suffix),
  )
}

const severities = new Map(
  Object.entries(policy.rules ?? {}).map(([name, entry]) => [
    name,
    Array.isArray(entry) ? entry[0] : entry,
  ]),
)

function severityOf(ruleName: string) {
  return severities.get(`anti-slop/${ruleName}`)
}

describe('lint policy', () => {
  test('hard anti-slop rules are errors', () => {
    for (const ruleName of hardRuleNames) {
      expect(severityOf(ruleName)).toBe('error')
    }
  })

  test('directional anti-slop rules are warnings', () => {
    for (const ruleName of directionalRuleNames) {
      expect(severityOf(ruleName)).toBe('warn')
    }
  })

  test('complexity is directional at maximum 22 with the modified switch variant', () => {
    expect(policy.rules?.['eslint/complexity']).toEqual(['warn', { max: 22, variant: 'modified' }])
  })

  test('native correctness rules stay hard and unused suppressions are errors', () => {
    expect(policy.rules['no-constant-condition']).toBe('error')
    expect(policy.rules['no-unsafe-optional-chaining']).toBe('error')
    expect(policy.options?.reportUnusedDisableDirectives).toBe('error')
  })
})

describe('anti-slop Oxlint plugin', () => {
  test('runs every fixture in one Oxlint invocation', () => {
    expect(report.number_of_files).toBe((ruleNames.length + policyFixtureNames.length) * 2)
    expect(report.number_of_rules).toBe(ruleNames.length + 1)
  })

  test('complexity reports 23 and accepts 22 under the modified switch variant', () => {
    expect(fixtureDiagnostics('complexity', 'invalid').map(({ code }) => code)).toEqual([
      'eslint(complexity)',
    ])
    expect(fixtureDiagnostics('complexity', 'valid')).toEqual([])
  })

  test('a justified line suppression silences a hard rule', () => {
    expect(fixtureDiagnostics('suppressions', 'valid')).toEqual([])
  })

  test('an unused suppression is reported as an error', () => {
    const diagnostics = fixtureDiagnostics('suppressions', 'invalid')
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.severity).toBe('error')
    expect(diagnostics[0]?.message).toMatch(/unused oxlint-disable directive/iu)
  })

  for (const ruleName of ruleNames) {
    test(`${ruleName} reports its invalid fixture and accepts its valid fixture`, () => {
      expect(fixtureDiagnostics(ruleName, 'invalid').map(({ code }) => code)).toEqual([
        `anti-slop(${ruleName})`,
      ])
      expect(fixtureDiagnostics(ruleName, 'valid')).toEqual([])
    })
  }
})
