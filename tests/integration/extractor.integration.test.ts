import { test, expect } from "@playwright/test";
import { injectPipeline, runFullPipeline } from "./helpers/inject";
import { AncestorStyleEntry, EvidencePacket } from "../../src/shared/types";

test.describe("extractEvidence: General Functionality Tests", () => {

    test.describe("getBoundingClientRect", () => {
        test.beforeEach(async ({ page }) => {
            await page.goto("/sticky-banner-ad.html");
            await injectPipeline(page);
        });

        test("reports pixel positions for fixed-position banners", async ({ page }) => {
            const res = await runFullPipeline(page);
            const topBannerPkt = res.packets.find(
                (p: EvidencePacket) => p.attributes.href?.includes("https://ad.example.com/top")
            );

            expect(topBannerPkt).toBeDefined();
            expect(topBannerPkt.position.top).toBeLessThan(80); // top pos between 0 and 80 acceptable
            expect(topBannerPkt.position.isInViewport).toBe(true);
        });

        test("reports pixel positions for fixed-position bottom bar", async ({ page }) => {
            const res = await runFullPipeline(page);
            const viewportHeight = await page.evaluate(() => window.innerHeight);
            const bottomBarPkt = res.packets.find(
                (p: EvidencePacket) => p.attributes.href?.includes("https://ad.example.com/bottom")
            );

            expect(bottomBarPkt).toBeDefined();
            expect(bottomBarPkt.position.top).toBeGreaterThan(viewportHeight - 150); // top pos between 'vp' - 150 and 'vp'
            expect(bottomBarPkt.position.isInViewport).toBe(true);
        });

        test("computes nonzero viewportCoverageRatio for large elements", async ({ page }) => {
            const res = await runFullPipeline(page);
            // banner anchors sit inside fixed-position containers that span the viewport,
            // so at least one packet should report meaningful coverage
            const hasSignificantCoverage = res.packets.some(
                (p: EvidencePacket) => p.position.viewportCoverageRatio > 0.01
            );

            expect(hasSignificantCoverage).toBe(true);
        });
    });

    test.describe("getComputedStyle", () => {
        test("extracts computed position values", async ({ page }) => {
            await page.goto("/sticky-banner-ad.html");
            await injectPipeline(page);

            const res = await runFullPipeline(page);

            // banner anchors themselves are static, but their fixed-position parent
            // should surface through the style ancestry walk
            const hasFixed = res.packets.some(
                (p: EvidencePacket) =>
                    p.styleAncestry.some((a: AncestorStyleEntry) => a.pos === "fixed")
            );

            expect(hasFixed).toBe(true);
        });

        test("extracts cursor style", async ({ page }) => {
            await page.goto("/fake-download-page.html");
            await injectPipeline(page);

            const res = await runFullPipeline(page);

            const ptrPkts = res.packets.filter(
                (p: EvidencePacket) => p.style.cursor === "pointer"
            );

            expect(ptrPkts.length).toEqual(2);
        });
    });

    test.describe("style ancestry walk", () => {
        test.beforeEach(async ({ page }) => {
            await page.goto("/deeply-nested-ad.html");
            await injectPipeline(page);
        });

        test("captures ancestry through deeply nested elements", async ({ page }) => {
            const res = await runFullPipeline(page);
            const link = res.packets.find(
                (p: EvidencePacket) => p.attributes.href?.includes("ad.example.com/deep")
            );

            expect(link).toBeDefined();
            // 12 .nest levels + .ad-overlay-wrapper + .container = 14 ancestors, < 30 = maxStyleAncestorDepth
            expect(link.styleAncestry.length).toEqual(14);

            const ancestorPositions = link.styleAncestry.map(
                (a: AncestorStyleEntry) => a.pos
            );

            expect(ancestorPositions).toContain("relative"); // nest-overlay + ad-overlay-wrapper
            expect(ancestorPositions).toContain("absolute"); // nest-absolute
        });

        test("records correct depth ordering", async ({ page }) => {
            const res = await runFullPipeline(page);
            const link = res.packets.find(
                (p: EvidencePacket) => p.attributes.href?.includes("ad.example.com/deep")
            );

            for (let i = 0; i < link.styleAncestry.length; i++) {
                expect(link.styleAncestry[i].depth).toBe(i + 1)
            }
        });

        test("respects body/html boundary stopping condition", async ({ page }) => {
            const res = await runFullPipeline(page);
            const link = res.packets.find(
                (p: EvidencePacket) => p.attributes.href?.includes("ad.example.com/deep")
            );

            const tags = link.styleAncestry.map((a: any) => a.tagName);

            expect(tags).not.toContain("body");
            expect(tags).not.toContain("html");
        });
    });

    test.describe("surrounding text extraction", () => {
        test.beforeEach(async ({ page }) => {
            await page.goto("/fake-download-page.html");
            await injectPipeline(page);
        });

        test("captures ad-related text", async ({ page }) => {
            const res = await runFullPipeline(page);

            const fakeDownloadPkt = res.packets.find(
                (p: EvidencePacket) => p.attributes.href?.includes("ad-network.example.com/click")
            );

            expect(fakeDownloadPkt).toBeDefined();

            const text = fakeDownloadPkt.surroundingText.join(" ").toLowerCase();

            expect(text).toMatch(/advertisement|download/i);
        });

        test("respects maxSurroundingTextFragments", async ({ page }) => {
            const res = await runFullPipeline(
                page, { maxSurroundingTextFragments: 2 },
            );

            for (const pkt of res.packets) {
                expect(pkt.surroundingText.length).toBeLessThanOrEqual(2);
            }
        });
    });

    test.describe("iframe handling", () => {
        test.beforeEach(async ({ page }) => {
            await page.goto("/iframe-ad.html");
            await injectPipeline(page);
        });

        test("discovers iframe elements", async ({ page }) => {
            const res = await runFullPipeline(page);

            const iframePkts = res.packets.filter(
                (p: EvidencePacket) => p.tagName === "iframe"
            );

            expect(iframePkts.length).toEqual(2);
        });

        test("reports isInIFrame as false for elements in the top-level page", async ({ page }) => {
            const res = await runFullPipeline(page);

            for (const pkt of res.packets) {
                expect(pkt.isInIFrame).toBe(false);
            }
        });
    });
});

test.describe("extractEvidence: Capping Stress Tests", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/high-element-count.html");
        await injectPipeline(page);
    });

    test("fixed top banner has correct positional data on dense page", async ({ page }) => {
        const res = await runFullPipeline(page);

        const topBanner = res.packets.find(
            (p: EvidencePacket) =>
                p.attributes.href?.includes("ad.example.com/top-banner")
        );

        expect(topBanner).toBeDefined();
        expect(topBanner.position.top).toBeLessThan(80);
        expect(topBanner.position.isInViewport).toBe(true);
    });

    test("disguised download button packet contains \"download\" in surrounding text", async ({ page }) => {
        const res = await runFullPipeline(page);

        const disguised = res.packets.find(
            (p: EvidencePacket) =>
                p.attributes.href?.includes("ad.example.com/disguised-download")
        );

        expect(disguised).toBeDefined();

        const text = disguised.surroundingText.join(" ").toLowerCase();
        expect(text).toMatch(/download/i);
    });

    test("evidence packets include ad containers on dense pages", async ({ page }) => {
        const res = await runFullPipeline(page);

        // ad containers with interactive descendants get skipped in favor of their children,
        // so look for packets marked as residing inside an ad container
        const adPkts = res.packets.filter((p: any) => p.isInAdContainer);

        expect(adPkts.length).toBeGreaterThanOrEqual(1);
    });
});

test.describe("extractEvidence: Advertisement Label in Sibling Tests", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/adsbygoogle-nested.html");
        await injectPipeline(page);
    });

    test("captures sibling \"Advertisement\" text for at least one ins.adsbygoogle elements", async ({ page }) => {
        const res = await runFullPipeline(page);

        // the ins.adsbygoogle wrappers get deduped in favor of their iframe children,
        // so the iframes serve as the extracted representatives of each ad slot
        const adIframePkts = res.packets.filter(
            (p: EvidencePacket) =>
                p.tagName === "iframe" && p.isInAdContainer
        );

        expect(adIframePkts.length).toBeGreaterThanOrEqual(1); // at least one adsbygoogle iframe found

        const hasAdLabel = adIframePkts.some(
            (p: EvidencePacket) =>
                p.surroundingText.join(" ").toLowerCase().includes("advertisement")
        );

        expect(hasAdLabel).toBe(true); // at least one found element has ad surrounding text
    });

    test("captures sibling label outside the ad container", async ({ page }) => {
        const res = await runFullPipeline(page);

        // iframe aswift_1 is inside the ins with data-ad-slot="1111111111"
        const firstAd = res.packets.find(
            (p: EvidencePacket) =>
                p.tagName === "iframe" && p.attributes.src === "about:blank" &&
                p.HTMLSnippet.includes("aswift_1")
        );

        expect(firstAd).toBeDefined();

        const text = firstAd.surroundingText.join(" ").toLowerCase();

        expect(text).toContain("advertisement");
    });

    test("captures advertisement label through intervening wrapper div", async ({ page }) => {
        const res = await runFullPipeline(page);

        // iframe aswift_3 is inside the ezoic-wrapped ins with data-ad-slot="3333333333"
        const ezoicIns = res.packets.find(
            (p: EvidencePacket) =>
                p.tagName === "iframe" && p.HTMLSnippet.includes("aswift_3")
        );

        expect(ezoicIns).toBeDefined();

        const text = ezoicIns.surroundingText.join(" ").toLowerCase();

        expect(text).toContain("advertisement");
    });
});

test.describe("extractEvidence: Wrapper Isolated Ad Link Tests", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/wrapper-isolated-ad.html");
        await injectPipeline(page);
    });

    // the bare minimum
    test("captures label from parent's <span> sibling", async ({ page }) => {
        const res = await runFullPipeline(page);

        const pkt = res.packets.find(
            (p: EvidencePacket) => p.attributes.href?.includes("click?id=3")
        );

        expect(pkt).toBeDefined();

        const text = pkt.surroundingText.join(" ").toLowerCase();

        expect(text).toContain("advertisement");
    });

    // more aggressive than previous test case
    test("captures label from parent's <p> sibling", async ({ page }) => {
        const res = await runFullPipeline(page);

        const pkt = res.packets.find(
            (p: EvidencePacket) => p.attributes.href?.includes("click?id=1")
        );

        expect(pkt).toBeDefined();

        const text = pkt.surroundingText.join(" ").toLowerCase();

        expect(text).toContain("your file is ready for download");
    });

    test("captures sibling label inside wrapper", async ({ page }) => {
        const res = await runFullPipeline(page);

        const pkt = res.packets.find(
            (p: EvidencePacket) => p.attributes.href?.includes("click?id=2")
        );

        expect(pkt).toBeDefined();

        const text = pkt.surroundingText.join(" ").toLowerCase();

        expect(text).toContain("advertisement");
    });
});

test.describe("extractEvidence: ATTR_NAMES Tests", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/adsbygoogle-nested.html");
        await injectPipeline(page);
    });

    test("ins.adsbygoogle packets include data-ad-slot in attributes", async ({ page }) => {
        const res = await runFullPipeline(page);

        const insPackets = res.packets.filter(
            (p: any) => p.tagName === "ins" && p.HTMLSnippet.includes("adsbygoogle")
        );

        expect(insPackets.length).toBeGreaterThanOrEqual(1);

        for (const pkt of insPackets) {
            expect(pkt.attributes["data-ad-slot"]).toBeDefined();
        }
    });

    test("ad container packets include data-ad-client in attributes", async ({ page }) => {
        const res = await runFullPipeline(page);

        const insPackets = res.packets.filter(
            (p: any) => p.tagName === "ins" && p.HTMLSnippet.includes("adsbygoogle")
        );

        const hasClient = insPackets.some(
            (p: any) => p.attributes["data-ad-client"] !== undefined
        );

        expect(hasClient).toBe(true);
    });
});