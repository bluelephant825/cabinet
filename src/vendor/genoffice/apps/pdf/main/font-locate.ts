/**
 * System font location moved to @genoffice/font-metrics (shared with the docs
 * metrics pipeline); re-exported here to keep pdf-main import paths stable.
 */
export { findFontCovering, findSystemFont, isTruetype } from '../../../packages/font-metrics/src/index'
