/**
 * This file acts as a factory function returning a plain Object that
 * holds every tunable parameter referenced in the extraction pipeline.
 */

export interface ExtractionConfig {
    maxElems: number;
    maxSnippetLength: number;
    maxSurroundingTextLength: number;
    maxSurroundingTextFragments: number;
    maxStyleAncestorDepth: number;  // used in style ancestry walk
    ancestorDepth: number;          // used in the text context walk
    siblingRadius: number;          // number of sibling elements to inspect on each side
    minElemWidth: number;           // min width to be considered (in pixels)
    minElemHeight: number;          // min height to be considered (in pixels)
    interactiveSelectors: string;   // CSS selector string used in 'selector.ts' (non-ad elements)
    adContainerSelectors: string;   // selector string (ad container elements)
    ignoredTags: Set<string>;       // tags to strip during sanitization
    attrNames: string[];            // attribute names to include
    adPatterns: RegExp[];           // patterns that justify including class/id in attributes
    contextTextTags: Set<string>;   // tags for which text collection is considered in parent walk
    maxContextTextLength: number;   // max char length for text collected from contextTextTags
}

export const DEFAULT_CONFIG: ExtractionConfig = {
    maxElems: 50,
    maxSnippetLength: 384,
    maxSurroundingTextLength: 200,
    maxSurroundingTextFragments: 5,
    maxStyleAncestorDepth: 30,      // fairly high since nestings >25 observed in practice
    ancestorDepth: 5,               // moderate since text labels need not live close to the target
    siblingRadius: 3,               // suitable for sites with deeply nested ads
    minElemWidth: 10,
    minElemHeight: 10,
    interactiveSelectors: [
        "a[href]",
        "button",
        "iframe",
        "input[type='submit']",
        "input[type='button']",
        "[role='button']",          // 'role' overrides implicit, default role
        "[onclick]",
    ].join(", "),
    adContainerSelectors: [
        "[class*='ezoic' i]",
        "[id^='ezwrp']",
        "ins.adsbygoogle",
        "div[id^='google_ads']",
        "div[id^='div-gpt-ad']",
        "[data-ad]",
        "[data-ad-slot]",
        "[data-adunit]",
    ].join(", "),
    ignoredTags: new Set([
        "script",
        "style",
        "noscript",
        "svg",
        "link",
        "meta",
    ]),
    attrNames: [
        "href", "src", "alt", "title", "aria-label", "download", "target",
        "data-ad-slot", "data-ad-client",
    ],
    adPatterns: [/ad/i, /ezoic/i, /sponsor/i, /promo/i, /gpt/i],
    contextTextTags: new Set([
        "span", "label", "small", "em", "strong", "b", "i",
        "mark", "abbr", "cite", "code", "sub", "sup", "p",
    ]),
    maxContextTextLength: 40,
}

/**
 * Tuning notes for future parameter sweeps.
 *   ->  'maxElems' controls the total output volume (i.e. packets x per-packet size
 *       = total tokens to process) and the total extraction time (since each element
 *       triggers 'getComputedStyle()' + DOM traversal). Also, 'maxElems' determines
 *       whether all threats get caught and whether the SLM context window is exceeded,
 *       which makes it the most impactful knob.
 *   ->  'maxSnippetLength' is the largest field in most 'EvidencePacket's. There is
 *       a clear tradeoff between capturing enough HTML and exceeding the SLM context
 *       window. 'maxSnippetLength' and 'maxElems' are inversely proportional and
 *       should be tuned together.
 *   ->  'maxStyleAncestorDepth' = n adds up to n additional 'getComputedStyle()'
 *       calls per element. Empirically, pointer-events tend to concentrate < 20
 *       levels above the innermost nested "Download" or similar text, so capping
 *       between 20 and the current 30 can yield ~1.5x speedup with low recall loss.
 *   ->  'interactiveSelectors' determines recall, making it a correctness parameter
 *       rather than a performance parameter. Tune by running the extractor on
 *       representative sites and manually inspecting what was missed.
 */