/**
 * Programmatic entry for `dsh-mcp-plugin`. The loader drives the plugin through
 * the host half directly (its `name` / `inject` / `Config` / `apply`); this
 * barrel is for consumers and tests that want the service, store, and mount
 * helpers by name.
 * @module dsh-mcp-plugin
 */

export * from './types.ts'
export { STORE_VERSION, defaultStorePath, loadStore, saveStore } from './store.ts'
export { MCP_CLIENT_PLUGIN, mountServer, unmountServer, toolsForServer, type LiveMount } from './mount.ts'
export { McpManager, apply, name, inject, Config } from './host.ts'
