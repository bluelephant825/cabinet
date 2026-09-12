# LLM Wiki Phase 9: Source classification

Implemented on 2026-09-11. `classification.ts` provides scoped taxonomy discovery,
category ranking, optional model decisions and validated classification plans.
SourceStore records a logical category and supports explicit reclassification.
No queue consumer, Raw version publisher or automatic model invocation is added.

## Cabinet taxonomy mapping

Cabinet has no existing semantic taxonomy service. This implementation derives
vocabulary from current Source categories and visible folder names instead of
creating another persistent taxonomy database. A root request additionally sees
empty category folders under its configured Raw directory. Room requests see
only that room's registered Source categories and visible folders, not other
rooms' working trees or root-wide empty Raw vocabulary.

Discovery reads directory names and existing source manifests, never evidence
bodies. Raw source directories are traversal boundaries, so `v1`, assets and
historical content cannot become categories. Generated layers, internal/hidden
folders, common asset/build folders, symlinks and nested Cabinet scopes are
excluded. Explicit room scopes require an accessible `kind: room` manifest.
Known categories include active-source counts and a root/room-scoped fingerprint.

Discovery is bounded to 500 categories and 2,000 traversed directories, with a
bounded directory depth. Excessive or case/Unicode-ambiguous taxonomies fail
explicitly rather than silently providing partial model context. Category paths
must be portable, visible, at most 240 characters and six segments deep, and may
not contain source manifest or reserved internal/asset/build components.

## Selecting a category

`SourceClassifier.classify(normalized, options)` returns a plan with taxonomy,
previous category (when applicable) and one decision:

- `existing`: a canonical existing category and short reason;
- `new`: a proposed category and explanation of why existing categories do not fit;
- `review`: insufficient confidence or a proposal requiring an explicit creation policy.

Without a model, the classifier uses a deterministic name-overlap heuristic.
Category tokens matching the document title/filename receive more weight than
tokens in its first 12,000 body characters. Repetition does not increase scores.
Only a unique positive strongest match is selected; ties and no match return
review. This is a conservative lexical baseline, not semantic topic inference.

An optional `ClassificationModel` supplies text-only inference through the
caller's configured Cabinet runtime. Existing adapter interfaces were inspected;
this feature does not introduce another provider registry or launch an agent with
general filesystem/tool permissions. A future orchestration caller must provide
an appropriately restricted inference function and honor the supplied abort
signal. No live model was used to implement or test this phase.

The prompt prefers the supplied taxonomy and treats both category labels and
document excerpts as untrusted data. It includes only bounded title/filename/body
context and category names/counts. The response must be a JSON decision of at most
8 KB; extra output fields, malformed JSON, unsafe paths and unknown existing
categories fail validation. The default deadline is 60 seconds and signals abort
on completion or timeout; an injected runner must implement actual cancellation
of its underlying request.

A proposed category matching existing vocabulary is canonicalized to that
existing category, including case aliases. Known ancestor spelling is retained
for proposed nested categories. New categories require `allowNewCategory: true`
from the caller; otherwise the result is review. This flag authorizes a plan,
not an immediate directory write. New plans cannot target a source-history
directory or conflict with a file. Taxonomy and Source state are checked again
after inference so stale decisions are rejected. Publication must revalidate
the plan at its later write boundary as well.

## Source ownership and reclassification

New registrations persist `source.classification` alongside their existing Raw
path. Legacy manifests derive the category from the directory containing the
source's `<slug>-<id>` folder. The manifest codec validates the optional field;
existing manifests need no read-time migration.

For a registered Source, ordinary updates keep its category without invoking
inference, even when the incoming topic differs. Setting `reclassify: true`
requests a new plan explicitly; it still performs no source mutation.

`SourceStore.reclassify(id, category, expectedCategory)` is the explicit mutation
boundary. Under the existing root lock it verifies that the Source is active and
the prior category is unchanged, then atomically updates logical classification
and `updatedAt`. It canonicalizes known category aliases. Source identity, Raw
directory, version records, original/normalized files, working binding and
current/compiled pointers remain unchanged. Historical evidence is not moved.

Logical classification can therefore differ from the physical Raw directory
after reclassification. Later versions continue under the existing Source
directory. This deliberate separation avoids relocating a large source history
because of one model decision. It does not implement a bulk physical-move tool,
UI action, classification audit log or Wiki reconciliation.

## Verification and next checkpoint

Eight new tests cover scoped taxonomy discovery/exclusions, existing-category
preference, uncertain/tied matches, update stability, canonical paths, creation
policy, bounded untrusted context, invalid model output, stale taxonomy, explicit
reclassification with retained files, timeout/abort and proposals without writes.
The full suite passes **555 tests**, including existing registry/queue/watcher
coverage. TypeScript and lint pass with zero errors and the existing 148 lint
warnings. Tests use deterministic inference fixtures, not a live provider.

Phase 10 is initial immutable Raw version creation. It remains pending the next
user instruction and will own classification-plan consumption and publication.
