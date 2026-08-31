/**
 * Aggregates the per-component canvas translation modules into the `canvasUi`
 * i18n namespace (one sub-key per component area). Each module exports
 * `{ en, zh }` with identical key structure; `src/i18n/index.ts` registers
 * the two assembled bundles via `addResourceBundle`.
 *
 * Canvas components read these with `useTranslation('canvasUi')` and keys like
 * `t('sidebar.title')` / `t('edit.adjust.exposure')`.
 */
import { adjust } from './adjust'
import { angle } from './angle'
import { chat } from './chat'
import { chatFrame } from './chatFrame'
import { edit } from './edit'
import { errorPage } from './errorPage'
import { generating } from './generating'
import { help } from './help'
import { image } from './image'
import { imageModels, imageProviders } from './imageProviders'
import { measure } from './measure'
import { media } from './media'
import { minimap } from './minimap'
import { mockup } from './mockup'
import { placement } from './placement'
import { sidebar } from './sidebar'
import { skills } from './skills'
import { wizard } from './wizard'
import { workspace } from './workspace'

const areas = {
  adjust,
  angle,
  chat,
  chatFrame,
  edit,
  errorPage,
  generating,
  help,
  image,
  imageModels,
  imageProviders,
  measure,
  media,
  minimap,
  mockup,
  placement,
  sidebar,
  skills,
  wizard,
  workspace,
}

type Area = keyof typeof areas

export const canvasUiEn = Object.fromEntries(
  (Object.keys(areas) as Area[]).map((k) => [k, areas[k].en]),
)

export const canvasUiZh = Object.fromEntries(
  (Object.keys(areas) as Area[]).map((k) => [k, areas[k].zh]),
)
