#!/usr/bin/env node
/**
 * Back-compat wrapper: genoffice provenance is now handled by the generic
 * scripts/vendor-provenance.mjs. Same CLI surface:
 *   node scripts/genoffice-provenance.mjs [--check] [--upstream <dir>]
 */
import { runVendorProvenance } from './vendor-provenance.mjs'

runVendorProvenance(process.argv.slice(2), 'genoffice')
