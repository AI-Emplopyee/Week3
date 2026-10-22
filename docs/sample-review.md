# Local sample form review

Open **Sample tests** in the local website, or `http://127.0.0.1:5173/?view=samples`.
The three ECUS form tabs use the existing `ECUS_FORM_FIELDS` catalog and saved AI
declaration values. Employee ToKhai values are separate comparison evidence;
they never supply form values. Missing, stale and unsupported values stay blank.
The forms are read-only snapshots, not approved or submitted declarations.

The view opens on the improved, source-reviewed GLM results for four reused
development shipments. It also preserves the original GLM low/high results,
the automatic mapping improvements, and 29 historical Kimi collections.
The 44-collection inventory explains the 15
scoring exclusions. Exact, reviewed content and coverage metrics retain the
frozen denominators. Extra goods rows and structured components are separate.
Equivalent-content credit is AI-assisted internal review, not independent human
validation. The earlier Kimi result on the same four pilot collections is labeled
as a historical reference; no fresh Kimi control is claimed.

The fixed visible comparison population is 300 components across the three
forms. The original GLM low result agrees on 129 (43.00%); automatic mapping
fixes agree on 140 (46.67%); the source-reviewed result with additional explicit
content review agrees on 159 (53.00%). The latter contains 138 exact matches,
21 reviewed equivalents, 51 differences and 90 missing values. Its exact score
is 46.00%, and its filled coverage is 70.00%. The 90% target remains unmet.
These stages use different levels of review, so the entire increase must not
be attributed to automatic extraction. The final result is AI-assisted internal
review, not independent validation or a fully automated success rate.

The improved snapshots come from `outputs/glm-form-improvement-20261020/`.
Their isolated mapping changes have not been promoted into live shipment
processing. All four attempted shipment-context enrichment envelopes failed
automatic acceptance; separately reviewed source facts supplied draft edits.
The saved failures and limitations remain visible in the result scope. The
40 structured goods components outside the visible controls are reported
separately and do not inflate the 300-component score. Sample selection,
forms and difference downloads all follow the selected saved result stage.

Run `python3 scripts/export-sample-review.py` to regenerate the local export from
the pinned immutable evidence. It checks input hashes, original-file hashes,
all exported form values against the frozen drafts, every comparison's actual
value, and aggregate scores. It makes no provider requests and changes no live
workspace records or frozen evaluation files.

Private generated data and original-byte copies live in the ignored directory
`.aicd-local/sample-review/`. Nothing is placed in `public/` or a browser bundle.
Only the local Vite listener exposes the read-only endpoints, after its existing
loopback/socket/host/origin gate. Originals are selected by opaque asset ID and
their hashes are verified before serving. The filesystem asset index is never
returned to the browser. Production builds do not install this middleware.

Validation: `node --experimental-strip-types --test tests/sample-review.test.ts
tests/local.test.ts`, TypeScript checking, and browser checks of all three forms,
model/sample switching, the differences filter and comparison details.
