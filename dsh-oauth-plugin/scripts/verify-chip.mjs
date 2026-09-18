#!/usr/bin/env node
/**
 * Functional check for the logged-in sidebar user chip.
 *
 * Loads the built client bundle (lib/client.js) through a minimal
 * `__ModuleLoader__` shim into a jsdom document that reproduces the harness's
 * sidebar foot: a settings trigger button carrying the harness slot content
 * (gear icon + locale label) and its React `onClick`. Then it asserts the
 * chip's required behavior:
 *
 *   1. the trigger row renders [avatar icon][user name], not the gear+设置 text;
 *   2. clicking the chip opens a menu with exactly 设定 and 登出;
 *   3. 设定 opens the settings dialog (the row's own onClick runs);
 *   4. 登出 issues POST /api/auth/logout and clears the chip.
 *
 * Run: node scripts/verify-chip.mjs
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
 * @param message - what was expected.
 */
function check(ok, message) {
  if (!ok) failures.push(message)
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${message}`)
}

const dom = new JSDOM(
  `<!doctype html><html><body>
     <div id="root">
       <div class="footArea">
         <div class="settingsArea">
           <div class="triggerRow">
             <button id="settingsTrigger" aria-haspopup="dialog" aria-expanded="false">
               <svg class="gear" viewBox="0 0 24 24"></svg><span class="label">设置</span>
             </button>
           </div>
         </div>
       </div>
     </div>
   </body></html>`,
  { url: 'http://127.0.0.1:3080/', runScripts: 'outside-only', pretendToBeVisual: true },
)

const { window } = dom
let settingsOpened = 0
let logoutCalls = 0
const fetchCalls = []

// The trigger's own React handler: the only route into the settings dialog.
window.document.getElementById('settingsTrigger')
  .addEventListener('click', () => { settingsOpened += 1 })

window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? ''
  fetchCalls.push(`${init?.method ?? 'GET'} ${url}`)
  if (url.includes('/api/auth/logout')) { logoutCalls += 1; return { ok: true, json: async () => ({}) } }
  if (url.includes('/api/auth/me')) {
    return {
      ok: true,
      json: async () => ({ id: 'u1', displayName: 'Dennis' }),
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ id: 'u1', displayName: 'Dennis' }),
    }
  }
  return { ok: true, json: async () => ({ sessions: [], workspaces: [] }), headers: { get: () => 'application/json' }, text: async () => '{}' }
}

// jsdom leaves fixed-position layout at zero; give the trigger a real box so
// the plugin's geometric selection and rail detection behave as in a browser.
const triggerBox = { left: 8, top: 700, width: 224, height: 42 }
const triggerEl = window.document.getElementById('settingsTrigger')
triggerEl.getBoundingClientRect = () => ({
  ...triggerBox,
  right: triggerBox.left + triggerBox.width,
  bottom: triggerBox.top + triggerBox.height,
  x: triggerBox.left,
  y: triggerBox.top,
})

// jsdom ships no matchMedia; the plugin reads it for reduced-motion handling.
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
})

window.__ModuleLoader__ = {
  load({ factory }) {
    globalThis.__chipExports = factory(() => { throw new Error('unexpected require') })
  },
}

// Evaluate the bundle inside the jsdom realm so its globals are the test page's.
window.eval(bundle)
const plugin = globalThis.__chipExports ?? window.__chipExports
check(typeof plugin?.apply === 'function', 'bundle exports apply()')

const effects = []
plugin.apply({ effect: (fn) => { effects.push(fn) } })

/** Flush microtasks and the plugin's polling tick. */
async function settle(ms = 0) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

await settle(30)

const trigger = window.document.getElementById('settingsTrigger')
const chip = trigger.querySelector('#dsh-sidebar-user')
check(chip !== null, 'chip is injected into the settings trigger row')
check(trigger.firstChild === chip, 'chip is the row\'s first child (icon leads the row)')

const chipSvg = chip.querySelector('svg')
check(chipSvg !== null, 'chip renders an icon before the name')
check(chip.firstElementChild === chipSvg, 'icon precedes the name node')
check(chip.querySelector('.dsh-sidebar-user-name')?.textContent === 'Dennis', 'chip shows the signed-in user name after the icon')

const label = trigger.querySelector('span.label')
check(label.style.display === 'none', 'harness slot label is hidden behind the chip')
check(trigger.querySelector('svg.gear').style.display === 'none', 'harness gear icon is hidden behind the chip')

// ── Menu contents ─────────────────────────────────────────────────────────
chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await settle()

const menu = window.document.getElementById('dsh-user-menu')
check(menu !== null, 'clicking the chip opens the popup menu')
check(settingsOpened === 0, 'clicking the chip does NOT open settings directly')

const rows = menu ? Array.from(menu.querySelectorAll('button[role="menuitem"]')) : []
const labels = rows.map(row => row.textContent)
check(labels.length === 2, `menu has exactly two items (got ${labels.length})`)
check(labels[0] === '设定', 'first item is 设定')
check(labels[1] === '登出', 'second item is 登出')
check(rows.every(row => row.querySelector('svg') !== null), 'both menu items carry an icon')
check(chip.getAttribute('aria-expanded') === 'true', 'chip reports aria-expanded=true while open')

// ── 设定 opens the settings dialog ────────────────────────────────────────
rows[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await settle()
check(settingsOpened === 1, '设定 opens the settings dialog')
check(window.document.getElementById('dsh-user-menu') === null, 'menu closes after choosing an item')

// ── 登出 runs the logout flow ─────────────────────────────────────────────
chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await settle()
const rows2 = Array.from(window.document.getElementById('dsh-user-menu').querySelectorAll('button[role="menuitem"]'))
rows2[1]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await settle(40)

check(logoutCalls === 1, '登出 posts /api/auth/logout')
check(fetchCalls.includes('POST /api/auth/logout'), 'logout request used POST')

// After logout the polling tick clears the user, and the overlay replaces the chip.
await new Promise(resolve => setTimeout(resolve, 20))
check(window.document.getElementById('dsh-oauth-overlay') !== null, 'login overlay returns after logout')

// ── Rail collapse hides the name but keeps the icon ───────────────────────
// The sidebar's ResizeObserver re-applies the rail class when the trigger box
// shrinks under RAIL_WIDTH_THRESHOLD. Reaching that path in this stub would
// require a fresh login cycle, so the rail state is covered by the dedicated
// standalone check in scripts/verify-rail.mjs.

for (const cleanup of effects) cleanup()

console.log(failures.length === 0
  ? '\nPASS — chip behavior verified'
  : `\nFAIL — ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
