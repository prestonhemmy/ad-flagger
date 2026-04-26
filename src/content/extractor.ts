/**
 * This file takes in the list of candidate 'Element's from 'selectors.ts'
 * and builds an 'EvidencePacket' for each candidate 'Element', appended
 * into a list which is passed to the background service worker to be fed
 * into the SLM inference engine.
 */

import { ExtractionConfig, DEFAULT_CONFIG } from "./config";
import { EvidencePacket,
         ExtractionResult,
         StyleData,
         PositionData,
         AncestorStyleEntry
} from "../shared/types";

export function extractEvidence(
    candidates: HTMLElement[],
    config: ExtractionConfig = DEFAULT_CONFIG,
): ExtractionResult {
    const packets: EvidencePacket[] = candidates.map((elem, i) =>
        buildPacket(elem, i, config)
    );

    return {
        url: window.location.href,
        timestamp: new Date().toISOString(),
        candidateCount: candidates.length,
        packets: packets,
    };
}

export function buildElementMap(candidates: HTMLElement[], offset: number = 0): Map<number, HTMLElement> {
    return new Map(candidates.map(
        (elem, i) => [i + offset, elem])
    );
}

function buildPacket(
    elem: HTMLElement,
    index: number,
    config: ExtractionConfig,
): EvidencePacket {
    return {
        id: index,
        tagName: elem.tagName.toLowerCase(),
        HTMLSnippet: extractSnippet(elem, config),
        attributes: extractAttributes(elem, config),
        style: extractStyle(elem),
        position: extractPosition(elem),
        styleAncestry: extractStyleAncestry(elem, config),
        surroundingText: extractSurroundingText(elem, config),
        isInIFrame: window !== window.top,
        isInAdContainer: elem.closest(config.adContainerSelectors) !== null
            || elem.matches(config.adContainerSelectors),
    };
}

function extractSnippet(elem: HTMLElement, config: ExtractionConfig): string {
    const clone = elem.cloneNode(true) as HTMLElement;

    // strip elements with ignored tags
    const selector = Array.from(config.ignoredTags).join(", ");
    for (const node of clone.querySelectorAll(selector)) {
        node.remove();
    }

    const snippet = clone.outerHTML;

    return snippet.length <= config.maxSnippetLength ?
        snippet : snippet.slice(0, config.maxSnippetLength);
}

function extractAttributes(elem: HTMLElement, config: ExtractionConfig): Record<string, string> {
    const attrs: Record<string, string> = {};

    for (const name of config.attrNames) {
        const value = elem.getAttribute(name);
        if (value !== null) {
            attrs[name] = value;
        }
    }

    // add class attribute iff matches on some ad pattern
    const classVal = elem.getAttribute("class");
    if (classVal && config.adPatterns.some((expr) => expr.test(classVal))) {
        attrs["class"] = classVal;
    }

    // add id attribute iff matches on some ad pattern
    const id = elem.getAttribute("id");
    if (id && config.adPatterns.some((expr) => expr.test(id))) {
        attrs["id"] = id;
    }

    return attrs;
}

function extractStyle(elem: HTMLElement): StyleData {
    const style = getComputedStyle(elem);

    return {
        pos: style.position,
        zIndex: style.zIndex,
        opacity: style.opacity,
        display: style.display,
        ptrEvents: style.pointerEvents,
        cursor: style.cursor,
    };
}

function extractPosition(elem: HTMLElement): PositionData {
    const rect = elem.getBoundingClientRect();
    const viewportArea = window.innerWidth * window.innerHeight;
    const elemArea = rect.width * rect.height;

    return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        viewportCoverageRatio: viewportArea > 0 ? elemArea / viewportArea : 0,
        isInViewport: rect.bottom > 0 && rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth,
    };
}

function extractStyleAncestry(
    elem: HTMLElement,
    config: ExtractionConfig
): AncestorStyleEntry[] {
    const ancestry: AncestorStyleEntry[] = [];

    let curr = elem.parentElement;
    let depth = 1;
    while (curr && depth <= config.maxStyleAncestorDepth) {
        const tag = curr.tagName.toLowerCase();

        // early exit on document or iframe boundary
        if (tag === "body" || tag === "html") break;

        const style = getComputedStyle(curr);
        ancestry.push({
            depth,
            tagName: tag,
            pos: style.position,
            zIndex: style.zIndex,
            ptrEvents: style.pointerEvents,
            opacity: style.opacity,
        });

        curr = curr.parentElement;
        depth++;
    }

    return ancestry;
}

function extractSurroundingText(
    elem: HTMLElement,
    config: ExtractionConfig
): string[] {
    const texts: string[] = [];

    // collect candidate's sibling text
    collectSiblingText(elem, "previousElementSibling", config.siblingRadius, texts);
    collectSiblingText(elem, "nextElementSibling", config.siblingRadius, texts);

    // parent walk
    let curr = elem.parentElement;
    let depth = 0;
    while (curr && depth < config.ancestorDepth) {
        const tag = curr.tagName.toLowerCase();
        if (tag === "body" || tag === "html") break;

        // collect parent's children text
        const text = collectChildText(curr, config);
        if (text) texts.push(text);

        collectSiblingText(curr, "previousElementSibling", config.siblingRadius, texts);
        collectSiblingText(curr, "nextElementSibling", config.siblingRadius, texts);

        curr = curr.parentElement;
        depth++;
    }

    // deduplicate, truncate each fragment and cap the overall number of fragments
    return [...new Set(texts)]
        .map((txt) => txt.slice(0, config.maxSurroundingTextLength))
        .slice(0, config.maxSurroundingTextFragments);
}

/** Helper function that collects textContent from adjacent sibling elements */
function collectSiblingText(
    elem: HTMLElement,
    direction: "previousElementSibling" | "nextElementSibling",
    radius: number,
    out: string[],
): void {
    let sibling = elem[direction];
    let count = 0;

    while (sibling && count < radius) {
        const text = (sibling.textContent || "").trim();
        if (text) out.push(text);
        sibling = sibling[direction];
        count++;
    }
}

/**
 * Helper function that collects text from child nodes which are either
 * text nodes or inline elements.
 */
function collectChildText(parent: HTMLElement, config: ExtractionConfig) {
    let txt = "";

    for (const node of parent.childNodes) {

        // if text node (ex. "Download") append directly
        if (node.nodeType === Node.TEXT_NODE) {
            txt += (node.textContent || "").trim() + " ";

            // o.w. if element node conditionally append textContent (ex. <span>Ad</span>)
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            const tag = el.tagName.toLowerCase();
            const content = (el.textContent || "").trim();

            if (config.contextTextTags.has(tag) && content.length > 0 &&
                content.length <= config.maxContextTextLength
            ) {
                txt += content + " ";
            }
        }
    }

    return txt.trim();
}