// Thin adapter over the shared pure renderer (helper/extension/lib/render.js), which is the single
// source of truth for the helper panel's HTML and is shared with the Chrome extension's panel.js.
// The only app-specific concern here is the category-icon base path: Vite resolves import.meta.env.BASE_URL
// to '/' in dev and './' in the packaged build (an absolute '/icons/…' breaks under the packaged file://
// origin, a relative one works).

/* eslint-disable @typescript-eslint/no-explicit-any */

// @ts-ignore — pure ESM JS lib, no TS declarations
import { renderBattle as _renderBattle, waitingHtml } from '../../../helper/extension/lib/render.js'
import type { Core, FormatData } from './data'

export { waitingHtml }

export interface RenderResult { format: string; html: string }

export function renderBattle(s: any, core: Core | null, fmt: FormatData): RenderResult {
  return _renderBattle(s, core, fmt, { assetBase: import.meta.env.BASE_URL })
}
