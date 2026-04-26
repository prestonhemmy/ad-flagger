/**
 * This file performs element discovery and pre-filtering before
 * returning an array of UI candidate 'Element's to then be passed to the
 * extraction layer.
 */

import { ExtractionConfig, DEFAULT_CONFIG } from "./config";


export function discoverCandidates(
    root: Document | HTMLElement = document,
    config: ExtractionConfig = DEFAULT_CONFIG,
): HTMLElement[] {

    /** === Discovery === */

    // query interactive elements first
    const interactive = Array.from(
        root.querySelectorAll<HTMLElement>(config.interactiveSelectors)
    );

    // query ad containers
    const adContainers = Array.from(
        root.querySelectorAll<HTMLElement>(config.adContainerSelectors)
    );

    // deduplicate
    const seen = new Set<HTMLElement>();
    const merged: HTMLElement[] = [];
    for (const elem of [...interactive, ...adContainers]) {
        if (!seen.has(elem)) {
            seen.add(elem);
            merged.push(elem);
        }
    }

    /** === Filtering === */

    const filtered = merged.filter((elem) => {
        // check if ignored tag first to avoid 'getComputedStyle()' and 'getBoundingClientRect()' calls
        let curr = elem.parentElement;
        while (curr) {
            if (config.ignoredTags.has(curr.tagName.toLowerCase())) return false;

            curr = curr.parentElement;
        }

        if (isNavigationLink(elem)) return false;

        const style = getComputedStyle(elem)
        if (style.display === "none" || style.visibility === "hidden") return false;

        const rect = elem.getBoundingClientRect();
        if (rect.width < config.minElemWidth || rect.height < config.minElemHeight) return false;

        // skip elements with no meaningful content (no text, no href, no src)
        const hasText = (elem.textContent || "").trim().length > 0;
        const hasLink = elem.hasAttribute("href") || elem.hasAttribute("src") || elem.querySelector("a[href], iframe[src]") !== null;
        if (!hasText && !hasLink) return false;

        return true;
    });

    /** === Priority Capping === */

    const adSet = new Set(adContainers);

    // check if element itself or if some ancestor is an ad container
    const isAdRelated = (elem: HTMLElement): boolean => {
        if (adSet.has(elem)) return true;
        return elem.closest(config.adContainerSelectors) !== null;
    }

    const interactiveSet = new Set(interactive);
    const filteredInteractive = filtered.filter(elem => interactiveSet.has(elem));

    const adFiltered: HTMLElement[] = [];
    const interactiveFiltered: HTMLElement[] = [];
    for (const elem of filtered) {
        if (isAdRelated(elem)) {
            // skip ad containers that have interactive descendants already in the
            // candidate list (the child is the actual suspicious element)
            if (adSet.has(elem) && filteredInteractive.some(child => child !== elem && elem.contains(child))) {
                continue;
            }
            adFiltered.push(elem);

        } else {
            interactiveFiltered.push(elem);
        }
    }

    const candidates: HTMLElement[] = [];

    // reserve up to 30% of maxElems slots for ad elements
    const adCap = Math.ceil(config.maxElems * 0.3);
    const used = new Set<HTMLElement>();
    for (const elem of adFiltered) {
        if (candidates.length >= adCap) break;
        candidates.push(elem);
        used.add(elem);
    }

    // fill remaining slots with interactive elements
    for (const elem of interactiveFiltered) {
        if (candidates.length >= config.maxElems) break;
        candidates.push(elem);
        used.add(elem);
    }

    // fill remaining slots (if available) with leftover ad elements
    for (const elem of adFiltered) {
        if (candidates.length >= config.maxElems) break;
        if (!used.has(elem)) {
            candidates.push(elem);
        }
    }

    return candidates;
}

/**
 * Returns true if 'elem' is a same-origin link inside a navigation tag
 * (<nav>, <header>, role="navigation"). These are filtered out as
 * uninteresting first-party site chrome.
 */
function isNavigationLink(elem: HTMLElement): boolean {
    if (elem.tagName.toLowerCase() !== "a") return false;

    const href = elem.getAttribute("href");
    if (!href) return false;

    // check if same origin
    try {
        const linkHost = new URL(href, window.location.href).hostname;
        const pageHost = window.location.hostname;

        const rootDomain = (host: string) =>
            host.split(".").slice(-2).join(".");
        if (rootDomain(linkHost) !== rootDomain(pageHost)) return false;
    } catch {
        return false;
    }

    // check if inside a navigation tag
    return elem.closest("nav, header, [role='navigation']") !== null;
}