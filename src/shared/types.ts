/**
 * Shared types crossing the extraction / classification / display
 * boundaries.
 *
 * 'EvidencePacket' is the unit of work produced by the content script
 * and consumed by the SLM in the background worker. 'ClassificationResult'
 * is the return trip. The 'BackgroundMessage' union covers every
 * cross-context message the central router accepts.
 */

/** === Extraction Pipeline === */

/**
 * Structured context extracted from a single interactive DOM element.
 * Designed to be token-efficient for SLM consumption.
 */
export interface EvidencePacket {
    id: number;                         // incremental ID unique to a given extraction pass
    tagName: string;                    // ex. "a", "button", "iframe"
    HTMLSnippet: string;                // truncated outerHTML bounded by 'config.maxSnippetLength'
    attributes: Record<string, string>; // ex. { "href": "www.ufl.edu",  "src": *, "alt": *, "title": *,
                                        // "aria-label": *, "download": *, "target": * }
    style: StyleData;
    position: PositionData;
    styleAncestry: AncestorStyleEntry[];
    surroundingText: string[];
    isInIFrame: boolean;
    isInAdContainer: boolean;
}

/** Subset of computed style properties relevant to deceptive UI detection. */
export interface StyleData {
    pos: string;
    zIndex: string;
    opacity: string;
    display: string;
    ptrEvents: string;
    cursor: string;
}

/** Positional metadata derived from 'getBoundingClientRect()'. */
export interface PositionData {
    top: number;
    left: number;
    width: number;
    height: number;
    viewportCoverageRatio: number;  // element area as a fraction of the viewport area
    isInViewport: boolean;
}

/** Compact subset of 'StyleData' for an ancestor of a DOM element of interest. */
export interface AncestorStyleEntry {
   depth: number;                   // number of levels above the target element, where 1 ~ parent
   tagName: string;
   pos: string;
   zIndex: string;
   ptrEvents: string;
   opacity: string;
}

/** Output of one extraction pass on a given Web page. */
export interface ExtractionResult {
    url: string;
    timestamp: string;              // ISO formatted
    candidateCount: number;         // Number of UI elements found (prior to capping)
    packets: EvidencePacket[];      // capped at 'config.maxElems'
}

/** === Classification Pipeline === */

/** Output of SLM classification on a single 'EvidencePacket' */
export interface ClassificationResult {
    id: number;                     // corresponds with 'EvidencePacket.id'
    category: string;               // ex. "disguised-ad", "visual-interference", "benign"
    confidence: string;             // ex. "low", "medium", "high"
    explanation?: string;           // optional brief SLM rationale
}

/** === Message Passing === */

interface ClassifyMessageType {
    type: "classify";
    packets: EvidencePacket[];
    url?: string;
}

interface StatusMessageType {
    type: "getStatus";
    tabId?: number;
}

interface ContentReadyMessageType {
    type: "contentReady";
    hostname: string;
}

interface SettingsMessageType {
    type: "getSettings";
}

interface EnableDetectionMessageType {
    type: "setDetectionEnabled";
    enabled: boolean;
    tabId?: number;
}

interface TrustMessageType {
    type: "setTrustSite";
    hostname: string;
    trusted: boolean;
    tabId?: number;
}

interface DetectionMessageType {
    type: "getDetections";
    tabId?: number;
}

interface IframeFlagMessageType {
    type: "iframeFlag";
    explanation?: string;
}

interface SetModelMessageType {
    type: "setModel";
    modelId: string;
}

interface SetDebugModeMessageType {
    type: "setDebugMode";
    enabled: boolean;
    tabId?: number;
}

export type BackgroundMessage =
    | ClassifyMessageType | StatusMessageType | ContentReadyMessageType | SettingsMessageType
    | EnableDetectionMessageType | TrustMessageType | DetectionMessageType | IframeFlagMessageType
    | SetModelMessageType | SetDebugModeMessageType

export function unreachable(value: never): never {
    throw new Error(`Unreachable: unexpected value ${JSON.stringify(value)}`);
}