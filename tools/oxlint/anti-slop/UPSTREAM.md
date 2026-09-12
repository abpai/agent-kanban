# Upstream

This plugin was vendored from [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop)
at commit `6d538555cb151d4121ed51a27db81890eacf8ae9` using its `install-anti-slop` skill.

The files are local project code after installation. Review upstream changes before replacing them.

## Local adaptations

- Recognize a `SAFETY:` comment immediately before an exported variable declaration that contains a type assertion. The rule checks only the `ExportNamedDeclaration` wrapper for exported `VariableDeclaration` nodes, preserving the existing comment ownership boundaries elsewhere.

## Agent Kanban integration

Copied from `abpai/templates.bun` at commit `c6cb464c697c469016c283c2c78ba0790c688d3a`.
The unused Effect plugin was omitted. The generic rules retain their behavior;
Knip identified an unused `isPopulatedObjectExpression` helper, which was removed,
and the module-private `WideningTargetKind` type no longer exports an unused API.
The fixture harness reads the existing root JSON policy, runs Oxlint through Bun,
and verifies the project complexity limit at 22/23. Root lint rules remain in
`.oxlintrc.json`; the vendored implementation and fixtures are excluded from
normal lint/format scans and checked through TypeScript and the fixture suite.
