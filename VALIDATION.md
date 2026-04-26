# Validation

Reference for the test fixtures shipped with the integration suite and the real-world sites used for manual spot-checks during development. Use this file to track classification results across model and prompt revisions.

## Integration fixtures

Located at `tests/integration/fixtures/`. Loaded by the Playwright suite via the integration server.

| Fixture | Purpose |
|---|---|
| `adsbygoogle-nested.html` | Nested `ins.adsbygoogle` slots; verifies sibling-label capture across wrapper boundaries. |
| `benign-stress-test.html` | Dense page with no deceptive elements; FP regression check. |
| `deeply-nested-ad.html` | 12+ levels of nesting; exercises the style ancestry walk. |
| `fake-download-page.html` | Disguised "Download" button next to the legitimate one; canonical TP case. |
| `hidden-elements.html` | Display-none / visibility-hidden / zero-size elements; filtering check. |
| `high-element-count.html` | Volume stress test for the candidate cap. |
| `iframe-ad.html` | Top-level iframe ad; cross-frame relay path. |
| `random-25-examples.html` | Mixed sample for general spot-checking. |
| `sticky-banner-ad.html` | Fixed-position banner; viewport coverage and position extraction. |
| `suspicious-stress-test.html` | Density of deceptive patterns; recall under load. |
| `wrapper-isolated-ad.html` | Ad link isolated by a wrapper; sibling-text walk through the wrapper. |

## Real-site spot-checks

Used for manual classification review. Re-run after any prompt or pipeline change.

- apkmirror.com
- mediafire.com
- stickpng.com
- pngtree.com
- pngegg.com
- pngwing.com
- apkcombo.com
- filehippo.com
- filecr.com
- y2mate.com


[//]: # (TODO: Resolve final sprint bugs that caused decrease in accuracy among real sites)
<!--
## Recording results

For each revalidation pass, log model, prompt revision, date, and per-site TP / FP / FN. Suggested table:

| Site | Model | Date    | TP | FP | FN | Notes                                      |
|---|---|---------|---|---|---|--------------------------------------------|
| apkmirror.com | Qwen3-4B | 4/26/25 | 4 | 0 | 3 | dense page surpasses element count config param |
| mediafire.com | Qwen3-4B | 4/26/25 | 5 | 1 | 0 | persistent nav link resembling an ad       |
-->