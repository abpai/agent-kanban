import policy from '../../../.oxlintrc.json'

// Reuse the configured plugin rules and options. Native application rules are
// excluded so each intentional violation isolates its own rule.
export default {
  options: { reportUnusedDisableDirectives: policy.options.reportUnusedDisableDirectives },
  categories: { correctness: 'off' },
  plugins: [],
  ignorePatterns: [],
  jsPlugins: [{ name: 'anti-slop', specifier: './index.ts' }],
  rules: Object.fromEntries(
    Object.entries(policy.rules).filter(
      ([name]) => name.startsWith('anti-slop/') || name === 'eslint/complexity',
    ),
  ),
}
