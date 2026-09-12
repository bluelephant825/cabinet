# Phase 23 — Wikidata/Wikipedia identity resolution

Completed 2026-09-11, using the canonical implementation sequence.

## Opt-in external identity lookup

`WikidataIdentityProvider` implements the Wikibase Action API search/detail flow.
It searches up to five item IDs by candidate name, then loads labels, aliases,
descriptions, P31 instance-of identifiers and the requested Wikipedia sitelink.
A final bounded request resolves type labels for assessment. Only the candidate
name and configured language are sent as search data; Source paths, bodies and
context are not sent to Wikidata. No Wikipedia article text is fetched.

The client uses the fixed HTTPS Wikidata API endpoint, disables redirects, omits
credentials, supplies a caller-configured identifying User-Agent and uses maxlag.
Each request has a ten-second deadline and a 2 MB streamed response limit, in
addition to compiler cancellation. HTTP failures, API errors/maxlag, malformed
responses, unsupported metadata sizes and rate limits fail explicitly rather than
being reported as “no match”. There is no automatic retry storm or persistent cache.
The service runs only when a caller explicitly supplies this provider.

The implementation was checked against official documentation:

- [Wikibase API](https://www.mediawiki.org/wiki/Wikibase/API/en)
- [Wikidata Action/REST API comparison](https://www.wikidata.org/wiki/Wikidata:REST_API/Comparison/en)
- [Wikidata sitelinks](https://www.wikidata.org/wiki/Help:Sitelinks/en-gb)
- [MediaWiki API etiquette](https://www.mediawiki.org/wiki/API:Etiquette)

## Resolution and review

`resolveExternalIdentity` consumes a compiler-verified semantic candidate, an
identity provider, and an optional assessment model. Results retain bounded choices,
assessment explanations and a resolved/review/unmatched status. External choices
contain validated QIDs, labels, aliases, descriptions, types and safe Wikipedia URLs.
Duplicate QIDs, malformed fields and unrelated URL origins are rejected.

Lexical equality alone cannot accept an identity. With no model, nonempty results
remain reviewable. With a model, each supplied choice must receive exactly one
assessment for label/alias agreement, semantic type compatibility and Source-context
compatibility. Acceptance additionally requires an exact normalized label/alias
match, a nonempty description and available type metadata. Exactly one compatible
choice may resolve; multiple compatible choices or insufficient information remain
for review. Missing choices produce unmatched. The model cannot invent QIDs or URLs.

The model receives the candidate's description and supporting quote plus external
identity metadata as untrusted data. Its instructions explicitly separate identity
from factual enrichment. These checks bound and explain resolution but do not prove
semantic correctness: homonyms, broad types and model mistakes may still need human
review. No Wikipedia prose, general external facts or label-derived claims are added
to knowledge provenance.

## Compiler integration

SourceSummaryPlanner accepts identity options as an optional fourth constructor
argument. Only candidates already eligible under durability rules are considered,
with at most 20 per compilation and sequential requests. When resolved, the Source
summary adds the QID's Wikidata link and its Wikipedia sitelink next to that candidate.
Ambiguous and absent identities receive explicit status text. External descriptions,
assessment prose and type facts are not copied into the Wiki's factual content or
Source evidence graph. Markdown-sensitive URL characters are encoded.

`externalIdentityMetadata` exposes the resolved QID and optional Wikipedia URL for
future entity/concept front matter. This phase does not edit or publish those pages,
rewrite local identity matches, persist a resolution cache or add a review UI. The
typed results make choices and reasons available to future callers. Without identity
options, existing compilation behavior has no new network calls.

If Wikipedia factual content is wanted later, it must first be captured as its own
Source/Raw version and compiled with that evidence. An identity link is not factual
support. This phase never silently bypasses that boundary.

## Verification and remaining work

Four focused tests cover unique/ambiguous/unmatched identities, missing type/context
requirements, untrusted URLs, invented QIDs, cancellation, fixed API requests, query
data minimization, sitelink construction, rate/API errors and response bounds. One
compiler integration test verifies durable-candidate links without importing external
descriptions or identity metadata into factual provenance. Network responses and
assessment models are deterministic fixtures; no live user Source was queried and
no live inference provider was started.

All 638 unit tests passed. TypeScript and targeted lint passed; full lint reported
zero errors and 148 existing warnings. Whitespace checks passed. Publication, durable
provenance inventory, queue/provider wiring and lifecycle completion remain open as
listed in the canonical implementation plan.

Phase 24 is Wiki index/overview/concept-table/log maintenance and awaits user instruction.
