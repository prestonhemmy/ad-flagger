import { beforeEach, describe, it, expect } from "vitest";
import { discoverCandidates } from "../../src/content/selectors";
import { ExtractionConfig, DEFAULT_CONFIG} from "../../src/content/config";

const TEST_CONFIG: ExtractionConfig = {
    ...DEFAULT_CONFIG,
    minElemWidth: 0,    // o.w. we'd fail all test cases since jsdom does not compute geometry,
    minElemHeight: 0,   // every call to 'getBoundingClientRect()' returns {top: 0, left: 0, ...}
};

/**
 * Helper function that creates a container div, sets its innerHTML,
 * appends it to 'document.body' (so elements have computed styles and
 * bounding rects) and returns the corresponding container.
 */
function createDOM(html: string): HTMLElement {
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
}

beforeEach(() => {
    document.body.innerHTML = "";   // reset DOM between tests
});

describe("discoverCandidates", () => {

    it("finds basic interactive elements", () => {
        const root = createDOM(`
           <a href="https://ufl.edu">Link</a>
           <button>Click here</button>
           <p>This is a paragraph.</p>
        `);

        const results = discoverCandidates(root, TEST_CONFIG);

        const tags = results.map((elem) => elem.tagName.toLowerCase());
        expect(tags).toContain("a");
        expect(tags).toContain("button");
        expect(tags).not.toContain("p");
    });

    it("excludes elements inside ignored tags", () => {
        const root = createDOM(`
           <a href="/visible">Visible Link</a>
           <noscript>
                <a href="/hidden">Hidden Link</a>
           </noscript>
           <svg>
                <a href="/svg">SVG Link</a>
           </svg>
        `);

        const results = discoverCandidates(root, TEST_CONFIG);

        expect(results).toHaveLength(1);
        expect(results[0].getAttribute("href")).toBe("/visible");
    });

    it("excludes elements with display:none or visibility:hidden", () => {
        const root = createDOM(`
           <a href="/visible" style="display:block;">Visible</a>
           <a href="/nonexistent" style="display:none;">Hidden</a>
           <button style="visibility:hidden;">Hidden</button>
        `);

        const results = discoverCandidates(root, TEST_CONFIG);

        expect(results).toHaveLength(1);
        expect(results[0].getAttribute("href")).toBe("/visible");
    });

    it("adheres to max element cap", () => {
        const links = Array.from(
            { length: 50 },
            (_, i) => `<a href="/link-${i}">Link</a>`
        ).join("\n")

        const root = createDOM(links);
        const config: ExtractionConfig = { ...TEST_CONFIG, maxElems: 5 };
        const results = discoverCandidates(root, config);

        expect(results).toHaveLength(5);
        expect(results[0].getAttribute("href")).toBe("/link-0");
        expect(results[4].getAttribute("href")).toBe("/link-4");
    });

    it("returns empty array when page has no interactive elements", () => {
        const root = createDOM(`
            <p>Words on a page</p>
            <div>Divs all around</div>
            <span>Spanning the whole wide world</span>
        `);

        const results = discoverCandidates(root, TEST_CONFIG);

        expect(results).toHaveLength(0);
    });
})