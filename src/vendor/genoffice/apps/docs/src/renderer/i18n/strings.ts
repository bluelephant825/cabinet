import { editorStrings } from './strings-editor'
import { ribbonStrings } from './strings-ribbon'
import { tableStrings } from './strings-table'

// Cabinet adaptation: the app/ and ai/ string domains belong to the upstream
// shell UI (App chrome, AI panel), which is not vendored. The embedded editor
// needs the editor/, table/ and ribbon/ domains (table-handle uses
// ribbonTableHandleTip), so the aggregator below keeps upstream's
// {lang → dict} shape while merging just those three. `StringKey = keyof
// typeof strings.zh` in locale.tsx then type-checks every t('...') call in
// the vendored editor against the merged dictionary.
export const strings = {
  zh: Object.assign({}, editorStrings.zh, ribbonStrings.zh, tableStrings.zh),
  en: Object.assign({}, editorStrings.en, ribbonStrings.en, tableStrings.en),
  ja: Object.assign({}, editorStrings.ja, ribbonStrings.ja, tableStrings.ja),
  ko: Object.assign({}, editorStrings.ko, ribbonStrings.ko, tableStrings.ko),
  fr: Object.assign({}, editorStrings.fr, ribbonStrings.fr, tableStrings.fr),
  de: Object.assign({}, editorStrings.de, ribbonStrings.de, tableStrings.de),
  es: Object.assign({}, editorStrings.es, ribbonStrings.es, tableStrings.es),
  th: Object.assign({}, editorStrings.th, ribbonStrings.th, tableStrings.th),
  id: Object.assign({}, editorStrings.id, ribbonStrings.id, tableStrings.id),
  ru: Object.assign({}, editorStrings.ru, ribbonStrings.ru, tableStrings.ru),
  ar: Object.assign({}, editorStrings.ar, ribbonStrings.ar, tableStrings.ar),
  pt: Object.assign({}, editorStrings.pt, ribbonStrings.pt, tableStrings.pt),
  it: Object.assign({}, editorStrings.it, ribbonStrings.it, tableStrings.it),
  pl: Object.assign({}, editorStrings.pl, ribbonStrings.pl, tableStrings.pl),
  nl: Object.assign({}, editorStrings.nl, ribbonStrings.nl, tableStrings.nl),
  ms: Object.assign({}, editorStrings.ms, ribbonStrings.ms, tableStrings.ms),
  he: Object.assign({}, editorStrings.he, ribbonStrings.he, tableStrings.he),
  hi: Object.assign({}, editorStrings.hi, ribbonStrings.hi, tableStrings.hi),
  'zh-TW': Object.assign(
    {},
    editorStrings['zh-TW'],
    ribbonStrings['zh-TW'],
    tableStrings['zh-TW'],
  ),
}
