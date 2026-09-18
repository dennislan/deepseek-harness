#!/usr/bin/env node
/**
 * Rail-state check for the sidebar user chip: with the sidebar collapsed the
 * trigger box shrinks below RAIL_WIDTH_THRESHOLD, and the chip must drop to an
 * icon-only box while still opening the two-item menu on screen.
 *
 * The chip is mounted before the collapse, then the trigger's measured box
 * shrinks and the sidebar's ResizeObserver must move it to the rail class.
 *
 * Run: node scripts/verify-rail.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

const failures = []
/**
 * Record a failed assertion.
 * @param ok - whether the expectation held.
 * @param message - what was expected.
 */
function check(ok, message) {
  if (!ok) failures.push(message)
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${message}`)
}

const dom = new JSDOM(
  `<!doctype html><html><body>
     <button id="settingsTrigger" aria-haspopup="dialog" aria-expanded="false">
       <svg class="gear" viewBox="0 0 24 24"></svg><span class="label">设置</span>
     </button>
   </body></html>`,
  { url: 'http://127.0.0.1:3080/', runScripts: 'outside-only', pretendToBeVisual: true },
)
const { window } = dom
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
window.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input?.url ?? ''
  if (url.includes('/api/auth/me')) {
    return { ok: true, json: async () => ({ id: 'u1', displayName: 'Dennis' }), headers: { get: () => 'application/json' } }
  }
  return { ok: true, json: async () => ({ sessions: [], workspaces: [] }), headers: { get: () => 'application/json' }, text: async () => '{}' }
}

const box = { left: 8, top: 700, width: 224, height: 42 }
const trigger = window.document.getElementById('settingsTrigger')
trigger.getBoundingClientRect = () => ({
  ...box,
  right: box.left + box.width,
  bottom: box.top + box.height,
  x: box.left,
  y: box.top,
})

const delivered = []
window.ResizeObserver = class {
  constructor(callback) { this.callback = callback }
  observe(target) { delivered.push(() => { this.callback([{ target }]) }) }
  disconnect() { delivered.length = 0 }
}

window.__ModuleLoader__ = {
  load({ factory }) { globalThis.__railExports = factory(() => { throw new Error('unexpected require') }) },
}

window.eval(bundle)
const plugin = globalThis.__railExports ?? window.__railExports
const effects = []
plugin.apply({ effect: (fn) => { effects.push(fn) } })

/** Flush microtasks and the plugin's polling tick. */
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
await settle(40)

const chip = trigger.querySelector('#dsh-sidebar-user')
check(chip !== null, 'chip mounted in the wide trigger row')
check(chip?.classList.contains('dsh-sidebar-user--rail') === false, 'wide row keeps the name visible (no rail class)')

// Collapse the sidebar and let the trigger's ResizeObserver fire.
box.width = 36
box.height = 36
for (const notify of delivered) notify()
await settle()

check(chip?.classList.contains('dsh-sidebar-user--rail') === true, 'collapsed sidebar switches the chip to the rail class')
check(chip?.querySelector('svg') !== null, 'rail chip keeps the avatar icon')
check(chip?.querySelector('.dsh-sidebar-user-name')?.textContent === 'Dennis', 'rail chip keeps the name node (hidden by CSS)')

chip?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await settle()
const menu = window.document.getElementById('dsh-user-menu')
check(menu !== null, 'rail chip still opens the menu')
check(menu?.querySelectorAll('button[role="menuitem"]').length === 2, 'rail menu keeps both items')
check(Number.parseFloat(menu?.style.left ?? '-1') >= 8, 'menu left edge stays inside the viewport')
check((menu?.style.top ?? '') !== '', 'menu is anchored to the chip on screen')

for (const cleanup of effects) cleanup()
console.log(failures.length === 0
  ? '\nPASS — rail behavior verified'
  : `\nFAIL — ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
