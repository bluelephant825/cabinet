import { editorStrings } from './strings-editor'
import { ribbonStrings } from './strings-ribbon'
import { tableStrings } from './strings-table'
import { zoteroStrings } from './strings-zotero'

// Cabinet adaptation: the app/ and ai/ string domains belong to the upstream
// shell UI (App chrome, AI panel), which is not vendored. The embedded editor
// needs the editor/, table/ and ribbon/ domains (table-handle uses
// ribbonTableHandleTip), so the aggregator below keeps upstream's
// {lang → dict} shape while merging just those three. `StringKey = keyof
// typeof strings.zh` in locale.tsx then type-checks every t('...') call in
// the vendored editor against the merged dictionary.
export const strings = {
  zh: Object.assign({}, ribbonStrings.zh, tableStrings.zh, editorStrings.zh, zoteroStrings.zh),
  en: Object.assign({}, ribbonStrings.en, tableStrings.en, editorStrings.en, zoteroStrings.en),
  ja: Object.assign({}, ribbonStrings.ja, tableStrings.ja, editorStrings.ja, zoteroStrings.ja),
  ko: Object.assign({}, ribbonStrings.ko, tableStrings.ko, editorStrings.ko, zoteroStrings.ko),
  fr: Object.assign({}, ribbonStrings.fr, tableStrings.fr, editorStrings.fr, zoteroStrings.fr),
  de: Object.assign({}, ribbonStrings.de, tableStrings.de, editorStrings.de, zoteroStrings.de),
  es: Object.assign({}, ribbonStrings.es, tableStrings.es, editorStrings.es, zoteroStrings.es),
  th: Object.assign({}, ribbonStrings.th, tableStrings.th, editorStrings.th, zoteroStrings.th),
  id: Object.assign({}, ribbonStrings.id, tableStrings.id, editorStrings.id, zoteroStrings.id),
  ru: Object.assign({}, ribbonStrings.ru, tableStrings.ru, editorStrings.ru, zoteroStrings.ru),
  ar: Object.assign({}, ribbonStrings.ar, tableStrings.ar, editorStrings.ar, zoteroStrings.ar),
  pt: Object.assign({}, ribbonStrings.pt, tableStrings.pt, editorStrings.pt, zoteroStrings.pt),
  it: Object.assign({}, ribbonStrings.it, tableStrings.it, editorStrings.it, zoteroStrings.it),
  pl: Object.assign({}, ribbonStrings.pl, tableStrings.pl, editorStrings.pl, zoteroStrings.pl),
  cs: Object.assign({}, ribbonStrings.cs, tableStrings.cs, editorStrings.cs, zoteroStrings.cs),
  nl: Object.assign({}, ribbonStrings.nl, tableStrings.nl, editorStrings.nl, zoteroStrings.nl),
  ms: Object.assign({}, ribbonStrings.ms, tableStrings.ms, editorStrings.ms, zoteroStrings.ms),
  he: Object.assign({}, ribbonStrings.he, tableStrings.he, editorStrings.he, zoteroStrings.he),
  hi: Object.assign({}, ribbonStrings.hi, tableStrings.hi, editorStrings.hi, zoteroStrings.hi),
  'zh-TW': Object.assign(
    {},
    ribbonStrings['zh-TW'],
    tableStrings['zh-TW'],
    editorStrings['zh-TW'],
    zoteroStrings['zh-TW'],
  ),
}
