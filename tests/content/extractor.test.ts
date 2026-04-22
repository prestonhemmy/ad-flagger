import { describe, it, expect } from "vitest";
import { extractEvidence } from "../../src/content/extractor";
import { ExtractionConfig, DEFAULT_CONFIG } from "../../src/content/config";

/**
 * Helper function that builds a minimal DOM tree inside a <body> element and
 * returns the target element.
 */
function makeElement(bodyHTML: string, selector: string): HTMLElement {
    document.body.innerHTML = bodyHTML;
    return document.querySelector<HTMLElement>(selector)!;
}

const config = DEFAULT_CONFIG;

describe("ExtractionResult", () => {

    it("returns correct metadata and empty packets array for zero candidates", () => {
        const result = extractEvidence([]);

        expect(result.url).toBe(window.location.href);
        expect(result.timestamp).not.toHaveLength(0);
        expect(result.candidateCount).toBe(0);
        expect(result.packets).toEqual([]);
    });
});

describe("extractSnippet", () => {

    it("strips ignored tags from the snippet", () => {
        const e = makeElement(
            `<div id="target">
                <script>alert("Hello World!")</script>
                <style>"Blah blah blah"</style>
                <svg><rect/></svg>
                <span>visible</span>
            </div>`,
            "#target",
        );

        const pkt = extractEvidence([e], config).packets[0];

        expect(pkt.HTMLSnippet).not.toContain("<script");
        expect(pkt.HTMLSnippet).not.toContain("<style");
        expect(pkt.HTMLSnippet).not.toContain("<svg");
        expect(pkt.HTMLSnippet).toContain("<span");
    });

    it("truncates the snippet at maxSnippetLength", () => {
        const text = "x".repeat(500);
        const e = makeElement(
            `<div id="target">
                ${text}
            </div>`,
            "#target",
        );

        const pkt = extractEvidence([e], { ...config, maxSnippetLength: 100 }).packets[0];

        expect(pkt.HTMLSnippet.length).toBeLessThanOrEqual(100);
    });
});

describe("extractAttributes", () => {

    it("captures only the specified attributes", () => {
        const e = makeElement(
            `<a id="target" href="https://ufl.edu" title="Go Gators!" data-tracking="123">link</a>`,
            "#target",
        );

        const { attributes } = extractEvidence([e]).packets[0];

        expect(attributes).toEqual({
            href: "https://ufl.edu",
            title: "Go Gators!",
        });
        expect(attributes).not.toHaveProperty("data-tracking");
        expect(attributes).not.toHaveProperty("id");
    });
});

describe("extractStyleAncestry", () => {

    it("stops at the <body> boundary and does not include body or html", () => {
        const e = makeElement(
            `<div id="outer">
                <div id="inner">
                    <a id="target" href="#">link</a>
                </div>
            </div>`,
            "#target",
        );

        const { styleAncestry } = extractEvidence([e]).packets[0];
        const tags = styleAncestry.map((a) => a.tagName);

        expect(tags).not.toContain("body");
        expect(tags).not.toContain("html");
    });

    it("returns ancestors in ascending depth order", () => {
        const e = makeElement(
            `<section>
                <article>
                    <div>
                        <a id="target" href="#">link</a>
                    </div>
                </article>
            </section>`,
            "#target",
        );

        const { styleAncestry } = extractEvidence([e]).packets[0];

        expect(styleAncestry[0].tagName).toBe("div");
        expect(styleAncestry[0].depth).toBe(1);
        expect(styleAncestry[1].tagName).toBe("article");
        expect(styleAncestry[1].depth).toBe(2);
        expect(styleAncestry[2].tagName).toBe("section");
        expect(styleAncestry[2].depth).toBe(3);
    });
});

describe("EvidencePacket", () => {

    it("contains every required field with the correct type", () => {
        const e = makeElement(`<a id="target" href="#">link</a>`, "#target");
        const pkt = extractEvidence([e]).packets[0];

        // top-level fields
        expect(typeof pkt.id).toBe("number");
        expect(typeof pkt.tagName).toBe("string");
        expect(typeof pkt.HTMLSnippet).toBe("string");
        expect(typeof pkt.attributes).toBe("object");
        expect(Array.isArray(pkt.styleAncestry)).toBe(true);
        expect(Array.isArray(pkt.surroundingText)).toBe(true);
        expect(pkt.surroundingText.every(s => typeof s === "string")).toBe(true);
        expect(typeof pkt.isInIFrame).toBe("boolean");

        // style field
        for (const key of ["pos", "zIndex", "opacity", "display", "ptrEvents", "cursor"] as const) {
            expect(typeof pkt.style[key]).toBe("string");
        }

        // position field
        for (const key of ["top", "left", "width", "height", "viewportCoverageRatio"] as const) {
            expect(typeof pkt.position[key]).toBe("number");
        }

        expect(typeof pkt.position.isInViewport).toBe("boolean");
    });
});
