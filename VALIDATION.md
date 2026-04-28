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

*Software Repositories*
- apkmirror.com
- apkcombo.com
- filehippo.com
- softpedia.com

*File Sharing Services and Torrent Sites*
- mediafire.com
- thepiratebay.org

*Niche and Content-Specific Sites*
- color-picker.dllplayer.com
- greeksymbols.net
- i2symbol.com

## Results

A true positive (TP) corresponds to a disguised ad that is correctly classified as such and rendered
with a visual overlay. A false positive (FP) refers to an HTML element that is flagged as deceptive with a
visual overlay but is actually benign. A false negative (FN) occurs when a disguised ad is either classified
as safe or is never classified to begin with.

| Site                       | Model    | Date    | TP | FP | FN | Precision | Recall    | Notes                                      |
|----------------------------|----------|---------|----|----|----|-----------|-----------|--------------------------------------------|
| apkmirror.com              | Qwen3-4B | 4/28/26 | 4  | 0  | 1  | 1.0       | 0.8       | dense Android APK repo                     |
| apkcombo.com               | Qwen3-4B | 4/28/26 | 0  | 2  | 2  | 0.0       | 0.0       | 3rd party Android APK repo                 |
| filehippo.com              | Qwen3-4B | 4/28/26 | 3  | 0  | 0  | 1.0       | 1.0       | curated Windows freeware portal            |
| softpedia.com              | Qwen3-4B | 4/28/26 | 2  | 3  | 0  | 0.4       | 1.0       | Windows/Mac freeware directory             |
| mediafire.com              | Qwen3-4B | 4/28/26 | 1  | 0  | 3  | 1.0       | 0.25 [^1] | cloud file-hosting; heavy ad rotation      |
| thepiratebay.org           | Qwen3-4B | 4/28/26 | 2  | 1  | 1  | 0.67      | 0.67      | BitTorrent magnet-link index               |
| color-picker.dllplayer.com | Qwen3-4B | 4/28/26 | 2  | 0  | 0  | 1.0       | 1.0       | low-traffic browser extension landing page |
| greeksymbols.net           | Qwen3-4B | 4/28/26 | 3  | 2  | 0  | 0.6       | 1.0       | Greek alphabet reference; AdSense          |
| i2symbol.com               | Qwen3-4B | 4/28/26 | 1  | 4  | 0  | 0.2 [^2]  | 1.0       | Unicode symbol/emoji copy & paste tool     |


**Aggregate results:** Macro precision $\approx 0.65 ~~$ Macro recall $\approx$ 0.75

---

[^1]: MediaFire's recall reflects the SafeFrame iframe rotation pattern, where the same outer container cycles
through multiple ad creatives faster than overlays can rebind without scroll activity.
[^2]: i2Symbol's FPs come from the SLM over-flagging on benign ads that share some overlap with deceptive ad
patterns prioritized in the system prompt.