import packageJson from '../package.json'

/**
 * Single source of truth for the build/package version. Import this anywhere a
 * release version is reported (e.g. MCP server metadata) so transports never
 * advertise a hard-coded version that drifts from package.json.
 */
export const VERSION: string = packageJson.version
