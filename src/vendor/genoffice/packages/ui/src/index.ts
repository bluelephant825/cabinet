// Cabinet adaptation: upstream's index.ts re-exports the whole shared UI kit
// (AiComposer, Dropdown, Markdown, icons, screentips…). The vendored docs
// editor only needs the WordArt presets and the shape-clip helper, so this
// barrel limits itself to the vendored modules (WordArt presets, shape-clip
// helper, and the find-text case folding the PDF search uses).
export {
  WORDART_PRESETS,
  wordArtStrokePx,
  wordArtSolidColor,
  type WordArtPreset,
} from './wordart-presets'
export { shapeClipCss } from './shape-gallery'
export { foldCase } from './find-text'
