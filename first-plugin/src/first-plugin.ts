import type { Context } from '@deepseek-ai/cordis'

export const name = 'first-plugin'

export function apply(ctx: Context) {
    console.log('[first-plugin] plugin loaded')
}
