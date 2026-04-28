/**
 * Content Script.
 *
 * Orchestrates the DOM parsing and extraction pipeline:
 *  1.  Candidate discovery (selectors.ts)
 *  2.  Context extraction (extractor.ts)
 *  3.  EvidencePacket assembly (extractor.ts)
 *  4.  Passing the 'EvidencePacket' to the background
 *      service worker for SLM inference
 *
 * The content script also retains a packet ID to DOM element mapping used in
 * the visual highlighting of "suspicious" elements flagged by the SLM and
 * returned via the background service worker.
 */

import { ExtractionResult, ClassificationResult } from "../shared/types"
import { discoverCandidates } from "./selectors";
import { extractEvidence, buildElementMap, filterExtractable } from "./extractor";
import { DEFAULT_CONFIG } from "./config";
import styles from "./highlight.css?inline";


const SAFE_IFRAME_HOSTS = new Set([
    "www.youtube.com",
    "youtube.com",
    "player.vimeo.com",
    "platform.twitter.com",
    "www.instagram.com",
    // add other common embed providers as needed
]);

const AD_NETWORK_SUFFIXES = [
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "googletagservices.com",
    "googleads.g.doubleclick.net",
    "safeframe.googlesyndication.com",
    "adnxs.com",
    "adsrvr.org",
    "amazon-adsystem.com",
    "criteo.com",
    "taboola.com",
    "outbrain.com",
    "admaster.cc",
    "ezoic.net",
    // add other common ad networks as needed
];

const SLOT_ID_BASE = 10000;

// frame-specific ID offset (top-level = 0, subframes > 0)
let idOffset = 0;

// maps packet IDs to their corresponding DOM elements
let elementMap = new Map<number, HTMLElement>();
let detectionActive = false;
let adObserver: MutationObserver | null = null;
let debugMode = false;

// maps packet IDs to the nearest ad container selector (used to recover
// flagged elements when the original DOM node has since been detached)
let containerSelectorMap = new Map<number, string>();

/** === Visual Highlight Overlay Logic ==== */

interface OverlayEntry {
    el: HTMLElement;
    overlay: HTMLDivElement;
    lastSrc?: string | null;    // for reposition rotation detection (iframe only)
    sourceURL?: string;         // subframe URL that produces this overlay (relay only)
}

const overlayMap = new Map<number, OverlayEntry>();
let flaggedElements = new Set<HTMLElement>();
const flaggedSubframeUrls = new Set<string>();
const debugOverlayIds = new Set<number>();

/** Injects the overlay/badge stylesheet once into the document head. */
function injectStyles() {
    const style = document.createElement("style");
    style.textContent = styles;
    document.head.appendChild(style);
}

/**
 * Returns the visible portion of an element's bounding rect, intersected
 * with each ancestor that has overflow clipping. Returns a zero-size rect
 * if the element is fully clipped.
 */
function getVisibleRect(el: HTMLElement): DOMRect {
    let rect = el.getBoundingClientRect();

    let parent = el.offsetParent as HTMLElement | null;
    while (parent && parent !== document.documentElement) {
        const style = getComputedStyle(parent);

        // check if parent capable of cropping children
        const overflows = style.overflow + style.overflowX + style.overflowY;
        if (overflows.includes("hidden") || overflows.includes("clip")) {
            const parentRect = parent.getBoundingClientRect();
            const top = Math.max(rect.top, parentRect.top);
            const left = Math.max(rect.left, parentRect.left);
            const bottom = Math.min(rect.bottom, parentRect.bottom);
            const right = Math.min(rect.right, parentRect.right);

            // if entirely clipped
            if (right <= left || bottom <= top) {
                return new DOMRect(left, top, 0, 0);    // zero-size rect
            }

            // o.w. update to visible rect
            rect = new DOMRect(left, top, right - left, bottom - top);
        }

        parent = parent.offsetParent as HTMLElement | null;
    }

    return rect;
}

/** Positions an overlay div over its target element's visible rect. */
function positionOverlay(el: HTMLElement, overlay: HTMLDivElement) {
    const rect = getVisibleRect(el);

    // hide overlay is zero-sized visible rect
    if (rect.width === 0 || rect.height === 0) {
        overlay.style.display = "none";
        return
    }

    overlay.style.display = "";
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
}

/**
 * Repositions every active overlay. Called on scroll and resize. If the
 * tracked element has detached from the DOM, falls back to its nearest
 * live ad container; if that is also gone, the overlay is removed.
 */
function repositionAllOverlays() {
    for (const [id, entry] of overlayMap) {
        const wasConnected = entry.el.isConnected;
        let recoveryAction:
            | "none" | "recovered-via-container" | "removed-no-container"
            | "soft-hidden-slot" = "none";

        // if the element became detached, try to re-locate it
        if (!wasConnected) {
            const container = findLiveAdContainer(id);
            if (container) {
                entry.el.classList.remove("ad-flagger-highlighted");
                container.classList.add("ad-flagger-highlighted");
                entry.el = container;

                // reset src baseline if the recovered element is itself an iframe
                entry.lastSrc = container.tagName.toLowerCase() === "iframe"
                    ? container.getAttribute("src") : undefined;

                recoveryAction = "recovered-via-container";
            } else if (id >= SLOT_ID_BASE) {
                // o.w. if iframe may be reoccupied, hide overlay and keep the entry
                entry.overlay.style.display = "none";

                // if relayed, release sourceURL for a later rebinding
                if (entry.sourceURL) {
                    flaggedSubframeUrls.delete(entry.sourceURL);
                    entry.sourceURL = undefined;
                }

                console.log("[ad-flagger] reposition: soft-hidden slot", {
                    id,
                    reason: "slot-detached-awaiting-rebind",
                    releasedSourceURL: entry.sourceURL ?? null,
                });

                continue;
            } else {
                // o.w. container no longer exists then remove overlay entirely
                console.log("[ad-flagger] reposition: removed", {id, reason: "no-live-container"});

                removeOverlay(id);
                continue;
            }
        }

        // capture state before positioning
        const isIframe = entry.el.tagName.toLowerCase() === "iframe";
        const currentSrc = isIframe ? entry.el.getAttribute("src") : null;
        const srcChanged = isIframe && entry.lastSrc !== undefined && currentSrc !== entry.lastSrc;

        const prevDisplay = entry.overlay.style.display;
        const rawRect = entry.el.getBoundingClientRect();
        const visibleRect = getVisibleRect(entry.el);

        positionOverlay(entry.el, entry.overlay);

        const nextDisplay = entry.overlay.style.display;
        const visibilityFlipped = prevDisplay !== nextDisplay;

        // log only on state transitions to keep volume manageable during scroll
        if (visibilityFlipped || srcChanged || recoveryAction !== "none") {
            const payload: Record<string, unknown> = {
                id,
                wasConnected,
                recoveryAction,
                rawRect: {
                    top: Math.round(rawRect.top),
                    left: Math.round(rawRect.left),
                    width: Math.round(rawRect.width),
                    height: Math.round(rawRect.height),
                },
                visibleRect: {
                    top: Math.round(visibleRect.top),
                    left: Math.round(visibleRect.left),
                    width: Math.round(visibleRect.width),
                    height: Math.round(visibleRect.height),
                },
                prevDisplay: prevDisplay || "(empty)",
                nextDisplay: nextDisplay || "(empty)",
                overlayTop: entry.overlay.style.top,
                overlayLeft: entry.overlay.style.left,
            };

            if (isIframe) {
                payload.srcChanged = srcChanged;
                payload.currentSrc = currentSrc;
                if (srcChanged) payload.previousSrc = entry.lastSrc;
            }

            console.log("[ad-flagger] reposition:", payload);
        }

        // update baselines for next iteration
        if (isIframe) entry.lastSrc = currentSrc;
    }
}

/** Tears down a single overlay (DOM node + bookkeeping). */
function removeOverlay(id: number) {
    const entry = overlayMap.get(id);
    if (entry) {
        entry.overlay.remove();
        entry.el.classList.remove("ad-flagger-highlighted");
        flaggedElements.delete(entry.el);
        if (entry.sourceURL) flaggedSubframeUrls.delete(entry.sourceURL);
        overlayMap.delete(id);
    }
}

/**
 * Adds a suspicious-element overlay (red outline + dismissible badge) for
 * the given element. Deduplicates by containment so a flagged ancestor
 * suppresses descendants and vice versa. If the element is currently
 * zero-dimensional but still attached, a ResizeObserver retries until it
 * gains size or 10 seconds elapses.
 */
function highlightElement(id: number, el: HTMLElement, explanation?: string) {
    const existing = overlayMap.get(id);
    if (existing && existing.el !== el) {
        flaggedElements.delete(existing.el);
        flaggedElements.add(el);

        existing.el.classList.remove("ad-flagger-highlighted");
        el.classList.add("ad-flagger-highlighted");
        existing.el = el;
        existing.lastSrc = el.tagName.toLowerCase() === "iframe"
            ? el.getAttribute("src") : undefined;

        positionOverlay(el, existing.overlay);
        console.log("[ad-flagger] highlight: rebound overlay", {id, tagName: el.tagName});
        return;
    }

    if (flaggedElements.has(el)) {
        console.log("[ad-flagger] highlight: drop — already flagged", {id, tagName: el.tagName, reason: "self"});
        return;
    }

    // containment deduplication
    for (const flagged of flaggedElements) {
        if (flagged.contains(el)) {
            console.log("[ad-flagger] highlight: drop — already flagged", {
                id, tagName: el.tagName, reason: "ancestor", relatedTag: flagged.tagName,
            });
            return;
        }
        if (el.contains(flagged)) {
            console.log("[ad-flagger] highlight: drop — already flagged", {
                id, tagName: el.tagName, reason: "descendant", relatedTag: flagged.tagName,
            });
            return;
        }
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
        if (!el.isConnected) {
            console.log("[ad-flagger] highlight: drop — zero-rect and detached", {id, tagName: el.tagName});
            return;
        }

        // if element exists but zero-dim then retry when it has dimensions
        let resolved = false;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.contentRect.width > 0 || entry.contentRect.height > 0) {
                    resolved = true;
                    observer.disconnect();
                    highlightElement(id, el, explanation);
                    return;
                }
            }
        });
        observer.observe(el);

        setTimeout(() => {
            if (resolved) return;
            observer.disconnect();
            console.log("[ad-flagger] highlight: drop — resize timeout", {
                id, tagName: el.tagName, connected: el.isConnected,
            });
        }, 10000); // stop retrying after 10s
        return;
    }

    flaggedElements.add(el);
    el.classList.add("ad-flagger-highlighted");

    const overlay = document.createElement("div");
    overlay.className = "ad-flagger-glow ad-flagger-glow--suspicious";

    const badge = document.createElement("span");
    badge.className = "ad-flagger-badge";

    const label = explanation || "Flagged as suspicious";
    badge.innerHTML = `<button class="ad-flagger-badge-x">&times;</button>Suspicious `;

    const closeBtn = badge.querySelector(".ad-flagger-badge-x")!;
    const textNode = badge.childNodes[1] as Text;
    badge.addEventListener("mouseenter", () => { textNode.textContent = label + " "; });
    badge.addEventListener("mouseleave", () => { textNode.textContent = "Suspicious "; });
    closeBtn.addEventListener("click", () => removeOverlay(id));

    overlay.appendChild(badge);
    positionOverlay(el, overlay);
    document.body.appendChild(overlay);

    const isIframe = el.tagName.toLowerCase() === "iframe";
    overlayMap.set(id, {el, overlay, lastSrc: isIframe ? el.getAttribute("src") : undefined});

    console.log("[ad-flagger] highlight: drew overlay", {
        id,
        tagName: el.tagName,
        rect: {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        },
    });
}

/**
 * Debug-mode only. Renders a "Queued" overlay over every candidate that
 * doesn't yet have one, so the user can see the pipeline working before
 * classifications come back.
 */
function showPendingOverlays() {
    if (!debugMode) return;
    for (const [id, el] of elementMap) {
        if (overlayMap.has(id)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const overlay = document.createElement("div");
        overlay.className = "ad-flagger-glow ad-flagger-glow--queued";

        const badge = document.createElement("span");
        badge.className = "ad-flagger-badge ad-flagger-badge--queued";
        badge.textContent = "Queued";
        overlay.appendChild(badge);

        positionOverlay(el, overlay);
        document.body.appendChild(overlay);
        overlayMap.set(id, { el, overlay });
        debugOverlayIds.add(id);
    }
}

/** Tears down every overlay and stops the late-injection observer. */
function clearAllOverlays() {
    detectionActive = false;
    stopAdObserver();
    for (const [id] of overlayMap) {
        removeOverlay(id);
    }
    flaggedElements.clear();
    debugOverlayIds.clear();
}

/** === Pipeline Logic === */

/**
 * Runs discovery + extraction pipeline. Returns a serializable
 * 'ExtractionResult' for message passing and updates the 'elementMap'.
 */
function runPipeline(): ExtractionResult {
    const candidates = discoverCandidates(document, DEFAULT_CONFIG);
    const result = extractEvidence(candidates, DEFAULT_CONFIG);

    for (const pkt of result.packets) {
        pkt.id += idOffset;
    }

    elementMap = buildElementMap(candidates, idOffset);

    // store each candidate's nearest ad container
    containerSelectorMap = new Map();
    for (const [id, el] of elementMap) {
        const container = el.closest(DEFAULT_CONFIG.adContainerSelectors) as HTMLElement | null;
        if (container) {
            const sel = buildContainerSelector(container);
            if (sel) containerSelectorMap.set(id, sel);
        }
    }

    return result;
}

/**
 * Builds a stable CSS selector for an ad container so it can be re-found
 * later in the DOM if the original element detaches. Prefers id, falls
 * back to the matching ad-container selector pattern.
 */
function buildContainerSelector(container: HTMLElement): string | null {
    if (container.id) return `#${CSS.escape(container.id)}`;

    // build attribute selector from ad container selectors matched on
    for (const sel of DEFAULT_CONFIG.adContainerSelectors.split(", ")) {
        if (container.matches(sel)) return sel;
    }

    return null;
}

/**
 * Handles classification results received from the background service
 * worker. Highlights suspicious elements.
 */
function handleClassifications(classifications: ClassificationResult[]): void {
    if (!detectionActive) return;
    for (const result of classifications) {
        const elem = elementMap.get(result.id);
        if (!elem) continue;

        if (result.category !== "benign") {
            // remove debug overlay before adding the real suspicious one
            if (debugOverlayIds.has(result.id)) {
                removeOverlay(result.id);
                debugOverlayIds.delete(result.id);
            }

            // if inside iframe defer visual highlighting to parent
            if (window !== window.top) {
                // TEMP (DEBUGGING)
                console.log("[ad-flagger] subframe: dispatching iframeFlag", {
                    packetId: result.id,
                    frameUrl: window.location.href,
                });

                chrome.runtime.sendMessage(
                    {
                        type: "iframeFlag",
                        explanation: result.explanation,
                        pageHostname: safeHostname(document.referrer) ?? "",
                    },
                    () => void chrome.runtime.lastError
                );
            } else {
                // if the element is detached, fall back to its ad container
                let target = elem;
                if (!elem.isConnected) {
                    const container = findLiveAdContainer(result.id);
                    if (!container) {
                        continue;
                    }

                    target = container;
                }

                highlightElement(result.id, target, result.explanation);
            }
        } else if (debugOverlayIds.has(result.id)) {
            // transition pending -> safe (green), then fade out
            const entry = overlayMap.get(result.id);
            if (entry) {
                entry.overlay.classList.remove("ad-flagger-glow--queued", "ad-flagger-glow--processing");
                entry.overlay.classList.add("ad-flagger-glow--safe");
                const badge = entry.overlay.querySelector(".ad-flagger-badge");
                if (badge) {
                    badge.classList.remove("ad-flagger-badge--queued", "ad-flagger-badge--processing");
                    badge.classList.add("ad-flagger-badge--safe");
                    badge.textContent = "Safe";
                }

                entry.overlay.classList.add("ad-flagger-glow--fade");
                entry.overlay.addEventListener("animationend", () => {
                    removeOverlay(result.id);
                    debugOverlayIds.delete(result.id);
                });
            }
        }
    }
}

/**
 * Helper function that looks up selector for a given packet ID and requeries to
 * find the current live container.
 */
function findLiveAdContainer(id: number): HTMLElement | null {
    const selector = containerSelectorMap.get(id);
    if (!selector) return null;

    const container = document.querySelector<HTMLElement>(selector);
    if (container && container.isConnected) {
        return container;
    }

    return null;
}

/** === Detection Running Logic === */

/**
 * Watches every known ad container for late-injected interactive elements
 * (e.g., GPT SafeFrame iframes that arrive after document_idle). New
 * candidates get extracted, given fresh frame-aware IDs, merged into the
 * element map, and shipped to the background worker for classification.
 */
function observeAdContainers() {
    stopAdObserver();

    const containers = document.querySelectorAll<HTMLElement>(DEFAULT_CONFIG.adContainerSelectors);
    if (containers.length === 0) return;

    adObserver = new MutationObserver((mutations) => {
        if (!detectionActive) return;
        const newCandidates: HTMLElement[] = [];

        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                // check inserted node
                const el = node as HTMLElement;
                if (el.matches(DEFAULT_CONFIG.interactiveSelectors)) {
                    newCandidates.push(el);
                }

                // check descendants of inserted node
                for (const child of el.querySelectorAll<HTMLElement>(DEFAULT_CONFIG.interactiveSelectors)) {
                    newCandidates.push(child);
                }
            }
        }

        if (newCandidates.length === 0) return;

        const result = extractEvidence(newCandidates, DEFAULT_CONFIG);

        // apply frame-specific ID offset
        for (const pkt of result.packets) {
            pkt.id += idOffset;
        }

        // merge new elements into existing element map
        const startID = Math.max(...elementMap.keys(), -1) + 1;
        const extractable = filterExtractable(newCandidates, DEFAULT_CONFIG);
        const newMap = new Map(
            extractable.map((e, i) => [startID + i, e])
        );

        for (const [id, el] of newMap) {
            elementMap.set(id, el);

            const container = el.closest(DEFAULT_CONFIG.adContainerSelectors) as HTMLElement | null;
            if (container) {
                const sel = buildContainerSelector(container);
                if (sel) containerSelectorMap.set(id, sel);
            }
        }

        // resolve existing packet IDs
        for (let i = 0; i < result.packets.length; i++) {
            result.packets[i].id = startID + i;
        }

        // increase idOffset past the new batch to avoid collisions
        idOffset += newCandidates.length;

        if (result.packets.length > 0) {
            chrome.runtime.sendMessage(
                { type: "classify", packets: result.packets, url: result.url },
                () => void chrome.runtime.lastError,
            );
        }
    });

    for (const container of containers) {
        adObserver.observe(container, { childList: true, subtree: true });
    }
}

function stopAdObserver() {
    if (adObserver) {
        adObserver.disconnect();
        adObserver = null;
    }
}

/** Kicks off the extraction pipeline and starts watching for late ad injection. */
function runDetection() {
    detectionActive = true;
    const extractionResult = runPipeline();

    showPendingOverlays();

    if (extractionResult.packets.length > 0) {
        chrome.runtime.sendMessage(
            { type: "classify", packets: extractionResult.packets, url: extractionResult.url },
            () => void chrome.runtime.lastError,
        );
    }

    // start watching for late injected ad content
    observeAdContainers();
}

if ((window as any).__suspiciousUiDetectorRan) {
    // skip (content script already ran in this frame)
} else {
    (window as any).__suspiciousUiDetectorRan = true;

    if (window !== window.top && SAFE_IFRAME_HOSTS.has(window.location.hostname)) {
        // skip detection for safe iframe hosts (ex. embedded YouTube iframe)
    } else {

        /** === Initialization === */

        injectStyles();
        window.addEventListener("scroll", repositionAllOverlays, { passive: true });
        window.addEventListener("resize", repositionAllOverlays, { passive: true });

        /** === Background-to-content script message handlers === */

        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message.type === "classificationStarted") {
                // debug mode: transition from queued (gray) -> processing (yellow)
                if (debugOverlayIds.has(message.id)) {
                    const entry = overlayMap.get(message.id);
                    if (entry) {
                        entry.overlay.classList.remove("ad-flagger-glow--queued");
                        entry.overlay.classList.add("ad-flagger-glow--processing");

                        const badge = entry.overlay.querySelector(".ad-flagger-badge");
                        if (badge) {
                            badge.classList.remove("ad-flagger-badge--queued");
                            badge.classList.add("ad-flagger-badge--processing");
                            badge.textContent = "Processing…";
                        }
                    }
                }
            } else if (message.type === "classificationResult") {
                handleClassifications([message.result]);
            } else if (message.type === "detectionToggle") {
                if (message.enabled) {
                    runDetection();
                } else {
                    clearAllOverlays();
                }
            } else if (message.type === "getDetections") {
                sendResponse({ count: flaggedElements.size });
            } else if (message.type === "setDebugMode") {
                debugMode = message.enabled;
                if (!message.enabled) {
                    for (const id of debugOverlayIds) {
                        removeOverlay(id);
                    }
                    debugOverlayIds.clear();
                }
            }

            // iframe -> top-level highlight relay (sent form background worker)
            if (message.type === "iframeFlagRelay") {
                if (window !== window.top) return

                console.log("[ad-flagger] relay: received iframeFlagRelay", {
                    sourceHost: safeHostname(message.sourceURL),
                    flaggedSubframeUrlsSize: flaggedSubframeUrls.size,
                });

                const sourceHost = safeHostname(message.sourceURL);
                if (!sourceHost) return;

                if (message.sourceURL && flaggedSubframeUrls.has(message.sourceURL)) {
                    // find the overlay entry that currently claims this sourceURL
                    let priorEntry: OverlayEntry | undefined;
                    let priorId: number | undefined;
                    for (const [id, entry] of overlayMap) {
                        if (entry.sourceURL === message.sourceURL) {
                            priorEntry = entry;
                            priorId = id;
                            break;
                        }
                    }

                    // if the prior claim is still bound to a connected element, then dedup
                    if (priorEntry && priorEntry.el.isConnected) {
                        console.log("[ad-flagger] relay: drop — sourceURL in flaggedSubframeUrls", {
                            sourceURL: message.sourceURL,
                            priorId,
                        });
                        return;
                    }

                    // o.w. prior claim is stale (entry detached, or orphaned), then release
                    // and fall through to iframe-lookup / rebind
                    flaggedSubframeUrls.delete(message.sourceURL);
                    if (priorEntry) priorEntry.sourceURL = undefined;

                    console.log("[ad-flagger] relay: stale claim released — proceeding to rebind", {
                        sourceURL: message.sourceURL,
                        priorId: priorId ?? null,
                        priorEntryFound: priorEntry !== undefined,
                    });
                }

                const iframes = Array.from(document.querySelectorAll("iframe"));
                const iframeHosts = iframes.map((f) => safeHostname(f.src));

                // exact hostname match
                let target: HTMLIFrameElement | null = null;
                let targetIndex = -1;
                let matchTier: "host" | "ad-family" | "none" = "none";  // TEMP (DEBUGGING)

                const tier1Skipped: { index: number; host: string | null; reason: string }[] = [];
                const tier2Skipped: { index: number; host: string | null; reason: string }[] = [];

                for (let i = 0; i < iframes.length; i++) {
                    if (iframeHosts[i] && iframeHosts[i] === sourceHost) {
                        if (flaggedElements.has(iframes[i])) {
                            tier1Skipped.push({ index: i, host: iframeHosts[i], reason: "in-flaggedElements" }); // TEMP (DEBUGGING)
                            continue;
                        }
                        target = iframes[i];
                        targetIndex = i;
                        matchTier = "host"; // TEMP (DEBUGGING)
                        break;
                    }
                }

                // ad-network family match (fallback approach)
                if (!target && isAdNetworkHost(sourceHost)) {
                    for (let i = 0; i < iframes.length; i++) {
                        const iframe = iframes[i];
                        const iframeHost = iframeHosts[i];
                        if (!iframeHost) {
                            tier2Skipped.push({ index: i, host: null, reason: "no-host" }); // TEMP (DEBUGGING)
                            continue;
                        }

                        if(!isAdNetworkHost(iframeHost)) {
                            tier2Skipped.push({ index: i, host: iframeHost, reason: "not-ad-family" }); // TEMP (DEBUGGING)
                            continue;
                        }

                        if (flaggedElements.has(iframe)) {
                            tier2Skipped.push({ index: i, host: iframeHost, reason: "in-flaggedElements" }); // TEMP (DEBUGGING)
                            continue;
                        }

                        target = iframe;
                        targetIndex = i;
                        matchTier = "ad-family";    // TEMP (DEBUGGING)
                        break;
                    }
                }

                if (target && targetIndex >= 0) {
                    const id = SLOT_ID_BASE + targetIndex;
                    const existing = overlayMap.get(id);

                    // TEMP (DEBUGGING)
                    if (existing && (existing.el !== target || !existing.el.isConnected)) {
                        console.log("[ad-flagger] relay: rebind candidate", {
                            slotId: id,
                            matchTier,
                            targetIndex,
                            existingElDetached: !existing.el.isConnected,
                            existingElIsSameNode: existing.el === target,
                        });
                    }

                    if (message.sourceURL) flaggedSubframeUrls.add(message.sourceURL);

                    highlightElement(id, target, message.explanation);

                    if (message.sourceURL) {
                        const entry = overlayMap.get(id);
                        if (entry) entry.sourceURL = message.sourceURL;
                    }
                } else {
                    // TEMP (DEBUGGING)
                    console.log("[ad-flagger] relay: drop — no target found", {
                        sourceURL: message.sourceURL,
                        sourceHost,
                        sourceHostIsAdFamily: isAdNetworkHost(sourceHost),
                        iframeCount: iframes.length,
                        iframeHosts,
                        tier1Skipped,
                        tier2Skipped,
                    });
                }
            }
        });

        /** === Entry point === */

        // ask background if detection should run for the current hostname
        chrome.runtime.sendMessage(
            {type: "contentReady", hostname: window.location.hostname},
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error("[ad-flagger] contentReady handshake failed:",
                        chrome.runtime.lastError.message);
                    return;
                }

                if (response?.shouldRun) {
                    idOffset = response.idOffset ?? 0;
                    debugMode = response.debugMode ?? false;
                    runDetection();
                }
            }
        );
    }
}

/** Helper that extracts domain from url */
function safeHostname(url?: string): string | null {
    if (!url) return null;
    try { return new URL(url).hostname; }
    catch { return null;}
}

/** Helper that checks if hostname in ad-network family */
function isAdNetworkHost(host: string | null): boolean {
    if (!host) return false;
    const h = host.toLowerCase();
    return AD_NETWORK_SUFFIXES.some((suffix) => h === suffix || h.endsWith("." + suffix));
}