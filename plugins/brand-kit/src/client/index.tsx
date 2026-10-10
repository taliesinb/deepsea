/**
 * @deepsea/brand-kit, browser half. Reads `globalThis.__DEEPSEA_BRAND_KIT__`
 * (the host half's view of the active profile) and occupies the shell's brand
 * cells for the parts the profile sets. All three are `single` slots, so the
 * registration replaces the shipped fallback outright:
 *
 *   sidebar.brand.mark            the mark at the size the shell asks for (24px in the
 *                                 brand row and the collapsed rail)
 *   sidebar.brand.name            the wordmark (`deepsea-brand-kit-name`; its typography
 *                                 comes from the host style row); this cell's fallback is
 *                                 the product title and the build-version chip together
 *   conversation.hero.brand.mark  the mark before the empty-session headline, in the
 *                                 shell's className so the headline geometry holds
 *
 * `mask` marks are a span whose CSS mask is the file and whose background is
 * the text colour (theme-following, like the whale); `image` marks are an <img>.
 *
 * Two shipped strings have no slot and belong to locale namespaces with one
 * occupant (`hero.headline`, `chat.deepDiving`), so their text is replaced in
 * place: a MutationObserver swaps "Into the Unknown" in the headline element
 * and "Deep diving" at the start of the running-turn label (its text nodes and
 * the shimmer's `data-shimmer-text` copy) whenever they render. React writes
 * the label again as its clock ticks, and the observer follows.
 *
 * The bundle's page in the Plugins panel gets the profiles card
 * (profiles-card.tsx) on `plugins.bundle.config`, keyed by the package name;
 * after the card reloads the page to apply a profile, `pluginNavigation`
 * opens that page again.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only (erased): the slot declarations this plugin occupies, and `ctx.slots`.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { BrandProfilesCard, REOPEN_KEY } from './profiles-card.tsx'
import styles from './style.css'

export const name = 'deepsea-brand-kit'
export const inject = ['slots']

/** This package's name: the key of its card on the Plugins page. */
const PACKAGE = '@deepsea/brand-kit'

/** The host half's payload ('' / null: that part keeps the shipped look). */
interface BrandKit {
  name: string
  headline: string
  turnStatus: string
  mark: { url: string, mode: 'mask' | 'image' } | null
}

declare global {
  // eslint-disable-next-line no-var
  var __DEEPSEA_BRAND_KIT__: BrandKit | undefined
}

/** Shipped strings (brand.mjs SHIPPED) and where they render. */
const HEADLINE = { selector: '[class*="_titleGroup"] > span:first-child', shipped: 'Into the Unknown' }
const TURN_STATUS = { selector: '[data-chat-running]', shipped: 'Deep diving' }

function Mark({ mark, size, className }: { mark: NonNullable<BrandKit['mark']>, size: number, className?: string | undefined }) {
  const cls = className === undefined ? 'deepsea-brand-kit-mark' : `deepsea-brand-kit-mark ${className}`
  if (mark.mode === 'image') return <img className={cls} src={mark.url} width={size} height={size} alt="" aria-hidden="true" />
  return <span className={cls} style={{ width: size, height: size }} aria-hidden="true" />
}

/** `text` with a leading `shipped` replaced, or undefined when there is nothing to do. */
function swapped(text: string | null, shipped: string, replacement: string): string | undefined {
  if (text === null || !text.startsWith(shipped) || text.startsWith(replacement)) return undefined
  return replacement + text.slice(shipped.length)
}

/**
 * Replace the shipped strings wherever they render, now and on every later
 * change. Returns the disposer.
 */
function substituteTexts(kit: BrandKit): () => void {
  const headline = kit.headline !== '' && kit.headline !== HEADLINE.shipped ? kit.headline : ''
  const status = kit.turnStatus !== '' && kit.turnStatus !== TURN_STATUS.shipped ? kit.turnStatus : ''
  if (headline === '' && status === '') return () => {}
  const fix = (): void => {
    if (headline !== '') {
      for (const element of document.querySelectorAll(HEADLINE.selector)) {
        const node = element.firstChild
        if (node !== null && node.nodeType === Node.TEXT_NODE && node.nodeValue === HEADLINE.shipped) node.nodeValue = headline
      }
    }
    if (status !== '') {
      for (const root of document.querySelectorAll(TURN_STATUS.selector)) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const next = swapped(node.nodeValue, TURN_STATUS.shipped, status)
          if (next !== undefined) node.nodeValue = next
        }
        for (const element of root.querySelectorAll('[data-shimmer-text]')) {
          const next = swapped(element.getAttribute('data-shimmer-text'), TURN_STATUS.shipped, status)
          if (next !== undefined) element.setAttribute('data-shimmer-text', next)
        }
      }
    }
  }
  const observer = new MutationObserver(fix)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-shimmer-text'] })
  fix()
  return () => { observer.disconnect() }
}

/** @param ctx - browser-plane plugin context. */
export function apply(ctx: Context): void {
  const kit: BrandKit = globalThis.__DEEPSEA_BRAND_KIT__ ?? { name: '', headline: '', turnStatus: '', mark: null }
  const mark = kit.mark
  if (mark !== null) {
    const SidebarMark = ({ size }: PropsRuntime<'sidebar.brand.mark'>) => <Mark mark={mark} size={size} />
    const HeroMark = ({ size, className }: PropsRuntime<'conversation.hero.brand.mark'>) => <Mark mark={mark} size={size} className={className} />
    ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, SidebarMark))
    ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HeroMark))
  }
  if (kit.name !== '') {
    const SidebarName = (_props: PropsRuntime<'sidebar.brand.name'>) => <span className="deepsea-brand-kit-name">{kit.name}</span>
    ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, SidebarName))
  }
  ctx.effect(() => substituteTexts(kit))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.deepseaBrandKit = ''
    style.textContent = styles
    document.head.appendChild(style)
    return () => { style.remove() }
  })
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE }, BrandProfilesCard))
  // After the card reloaded the page to apply a profile, open its page again.
  ctx.inject(['pluginNavigation'], (inner) => {
    let reopen = false
    try {
      reopen = sessionStorage.getItem(REOPEN_KEY) !== null
      sessionStorage.removeItem(REOPEN_KEY)
    } catch { /* storage unavailable */ }
    if (reopen) inner.pluginNavigation.openBundle(PACKAGE)
  })
}
