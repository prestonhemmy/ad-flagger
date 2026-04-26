/**
 * Background-side WebLLM driver.
 *
 * Owns the SLM engine lifecycle (load / unload / model swap) and consumes
 * 'EvidencePacket's enqueued by the central message router. Each packet is
 * compiled into a structured user prompt, sent through the SLM, and the
 * resulting SUSPICIOUS / SAFE classification is shipped back to the
 * originating tab as a 'ClassificationResult'.
 *
 * Per-tab queues keep the active tab responsive when many tabs are
 * scanning at once; iframe packets are prioritized within each queue
 * so cross-frame relays land before top-level highlights.
 */

import { CreateMLCEngine, MLCEngineInterface } from "@mlc-ai/web-llm";
import { EvidencePacket, ClassificationResult } from "../shared/types";
import { DEFAULT_MODEL_ID } from "../shared/models";

const SYSTEM_PROMPT =
`You classify web UI elements as SUSPICIOUS or SAFE.

SUSPICIOUS means the element tries to TRICK the user. When uncertain, choose SAFE.

SUSPICIOUS — any element that deceives:
- Links/buttons that say "Download" but href goes to an ad network or unrelated domain
- Text like "Your file is ready", "Update required", "Your computer is infected"
- An iframe or element inside a known ad container (adContainer=true) on a file-hosting or download page, regardless of whether it is labeled "Advertisement" — the ad is positioned to visually interfere with the user's intended action
- Fake system dialogs, fake antivirus warnings, fake browser notifications
- "Click Allow to continue", "Enable notifications to verify"
- An ad that disguises itself as a download button or system message

SAFE — everything else, including:
- Legitimate download links (href points to an actual file like .apk, .exe, .zip)
- Links where href domain matches the page domain (first-party navigation, downloads, upsells)
- Links to well-known app stores (play.google.com, apps.apple.com)
- FAQ/help/support links (href contains /faq, /help, /support, or element text is a help icon like [?])
- Software suggestion links on file hosting sites ("Open with...", "Can be opened with...")
- First-party premium upsells ("Try Ultra", "Go Pro", "Upgrade", "Download Faster")
- Normal buttons and links (Subscribe, Sign up, Learn more)
- A site's own download button (href subdomain matches page domain, e.g., download.example.com on example.com)
- Ad container wrapper elements (div, ins) that are empty or contain only standard ad labels, on pages where they do NOT overlap with a primary user action (e.g., a download button)- Standard ad labels ("Advertisement", "Sponsored")
- onclick, alert(), analytics, UI toggles

Key rule: if an element says "Download" but its href goes to an ad network (not a real file), it is SUSPICIOUS. The fact that it is inside an ad does NOT make it safe.

Think step-by-step in 1-2 plain sentences first. No markdown, no bullet points, no formatting. Then, your very last word MUST be either SUSPICIOUS or SAFE. Nothing else may come after it. If your last word is anything other than SUSPICIOUS or SAFE, your output is invalid.`;

let currentModelId = DEFAULT_MODEL_ID;
let engine: MLCEngineInterface | null = null;
let engineInitPromise: Promise<MLCEngineInterface> | null = null;
let generation = 0;

export type PipelineStatus =
	| { stage: "loading"; modelId: string; progress: number }
	| { stage: "classifying"; total: number; done: number }
	| { stage: "done" };

const tabStatus = new Map<number, PipelineStatus>();
const tabProgress = new Map<number, { total: number; done: number }>();
const tabGeneration = new Map<number, number>();

const tabQueues = new Map<number, QueueEntry[]>();
let activeTabId: number | undefined;
let processingQueue = false;

interface QueueEntry {
	packet: EvidencePacket;
	url?: string;
	tabId: number;
	gen: number;
	tabGen: number;
}

export function setActiveTab(tabId: number) {
	activeTabId = tabId;
}

/**
 * Cancels all pending classifications for a tab. Used when the user
 * trusts the site or otherwise opts out mid-scan.
 */
export function cancelTab(tabId: number) {
	tabGeneration.set(tabId, (tabGeneration.get(tabId) ?? 0) + 1);
	tabProgress.delete(tabId);
	tabStatus.delete(tabId);
	tabQueues.delete(tabId);
}

/** Pushes a status update to the popup and caches it per-tab. */
function broadcastStatus(status: PipelineStatus, tabId?: number) {
	if (tabId !== undefined) tabStatus.set(tabId, status);
	chrome.runtime.sendMessage({ type: "statusUpdate", status, tabId }).catch(() => {});
}

export function getStatusForTab(tabId: number): PipelineStatus {
	return tabStatus.get(tabId) ?? { stage: "done" };
}

/**
 * Lazy-loads the SLM engine. Subsequent callers share the same in-flight
 * load promise so we never trigger more than one model download.
 */
export async function getEngine(): Promise<MLCEngineInterface> {
	await modelIdReady;
	if (engine) return engine;
	if (engineInitPromise) return engineInitPromise;

	console.log("[ad-flagger] loading model:", currentModelId);
	engineInitPromise = CreateMLCEngine(currentModelId, {
		initProgressCallback: ({ text, progress }) => {
			console.log(`[ad-flagger] ${(progress * 100).toFixed(0)}% — ${text}`);
			broadcastStatus({ stage: "loading", modelId: currentModelId, progress });
		},
	}).then((e) => {
		engine = e;
		console.log("[ad-flagger] model ready");
		return e;
	}).catch((err) => {
		engineInitPromise = null;
		console.error("[ad-flagger] failed to load model:", err);
		throw new Error(`Model failed to load: ${err}`);
	});

	return engineInitPromise;
}

const modelIdReady = new Promise<void>((resolve) => {
	chrome.storage.local.get(["modelId"], (result) => {
		if (result.modelId) currentModelId = result.modelId;
		resolve();
	});
});

/**
 * Swaps the active SLM. Bumps the generation counter so any in-flight
 * classifications still queued against the old engine get treated as
 * stale and skipped. The previous engine is unloaded best-effort.
 */
export async function setModelId(newId: string): Promise<void> {
	currentModelId = newId;
	generation++;
	tabProgress.clear();
	tabQueues.clear();
	const oldEngine = engine;
	engine = null;
	engineInitPromise = null;
	if (oldEngine) {
		try { await oldEngine.unload(); } catch { /* ignore */ }
	}
}

/**
 * Compiles an evidence packet into the structured user prompt fed to the
 * SLM. Aggressively caps lengths so the prompt stays within the SLM
 * context window even on packets with large HTML snippets or surrounding
 * text. Adds a same-origin signal when the packet's href shares an eTLD+1
 * with the page hostname (a strong negative cue for "disguised ad").
 */
function buildPrompt(p: EvidencePacket, url?: string): string {
	const parts: string[] = [];
	if (url) {
		try { parts.push(`page=${new URL(url).hostname}`); }
		catch { /* skip */ }
	}
	parts.push(`<${p.tagName}> ${p.HTMLSnippet.slice(0, 200)}`)

	const href = p.attributes.href;
	if (href) {
		parts.push(`href=${href.slice(0, 150)}`);
		if (url && isSameSite(href, url)) {
			parts.push("sameOrigin=true");
		}
	}

	const ariaLabel = p.attributes["aria-label"];
	if (ariaLabel) parts.push(`ariaLabel=${ariaLabel.slice(0, 60)}`);

	const title = p.attributes["title"];
	if (title) parts.push(`title=${title.slice(0, 60)}`);

	if (p.style.pos !== "static") parts.push(`pos=${p.style.pos}`);
	if (p.isInIFrame) parts.push("iframe=true");
	if (p.isInAdContainer) parts.push("adContainer=true");

	// aggressively cap (3 text fragments, 120 total characters)
	const ctx = p.surroundingText?.filter(Boolean).slice(0, 3).join(" | ").slice(0, 120);
	if (ctx) parts.push(`context: ${ctx}`)

	return parts.join("\n");
}

// NOTE: Fails on edge cases like 'example.co.uk' but covers majority of site domains
function isSameSite(href: string, url: string): boolean {
	try {
		const hrefHost = new URL(href, url).hostname;
		const pageHost = new URL(url).hostname;
		const tld =
			(host: string) => host.split('.').slice(-2).join('.');
		return tld(hrefHost) == tld(pageHost);
	} catch {
		return false;
	}
}

/**
 * Runs a single SLM completion and parses the SUSPICIOUS/SAFE verdict
 * from the trailing word of the response.
 */
async function classifyOne(eng: MLCEngineInterface, prompt: string): Promise<{ suspicious: boolean; raw: string }> {
	const completion = await eng.chat.completions.create({
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: prompt + "\n\n/no_think" },
		],
		max_tokens: 128,
		temperature: 0,
	});

	const raw = completion.choices[0]?.message?.content ?? "";
	const lastWord = raw.trim().split(/\s+/).pop()?.toUpperCase().replace(/[^A-Z]/g, "") ?? "";
	return { suspicious: lastWord === "SUSPICIOUS", raw };
}

/**
 * Adds packets to the per-tab classification queue. Iframe packets jump
 * to the front so cross-frame relays resolve before any top-level
 * highlights they need to drive.
 */
export function enqueuePackets(packets: EvidencePacket[], url: string | undefined, tabId: number): void {
	console.log(`[ad-flagger] enqueuing ${packets.length} packets for tab ${tabId}`);

	const gen = generation;
	const tabGen = tabGeneration.get(tabId) ?? 0;

	const progress = tabProgress.get(tabId);
	if (progress) {
		progress.total += packets.length;
	} else {
		tabProgress.set(tabId, { total: packets.length, done: 0 });
	}

	const iframeEntries: QueueEntry[] = [];
	const otherEntries: QueueEntry[] = [];
	for (const packet of packets) {
		const entry = { packet, url, tabId, gen, tabGen };
		if (packet.tagName === "iframe" || packet.isInIFrame) {
			iframeEntries.push(entry);
		} else {
			otherEntries.push(entry);
		}
	}

	const existing = tabQueues.get(tabId);
	if (existing) {
		existing.unshift(...iframeEntries);
		existing.push(...otherEntries);
	} else {
		tabQueues.set(tabId, [...iframeEntries, ...otherEntries]);
	}

	processQueue();
}

/**
 * Drains the global queue serially. Re-loads the engine if the model was
 * swapped mid-drain and skips any entries that have gone stale during
 * the wait.
 */
async function processQueue(): Promise<void> {
	if (processingQueue) return;
	processingQueue = true;

	try {
		let eng = await getEngine();
		let currentGen = generation;

		let entry: QueueEntry | undefined;
		while ((entry = pickNext()) !== undefined) {
			if (generation !== currentGen) {
				eng = await getEngine();
				currentGen = generation;
			}

			if (isEntryStale(entry)) continue;

			const { packet: pkt, url, tabId } = entry;
			const hostname = url
				? (() => { try { return new URL(url).hostname; } catch { return url; } })() : "unknown";

			const p = tabProgress.get(tabId);
			if (p) broadcastStatus({ stage: "classifying", total: p.total, done: p.done }, tabId);

			chrome.tabs.sendMessage(tabId, { type: "classificationStarted", id: pkt.id }).catch(() => {});

			const prompt = buildPrompt(pkt, url);
			let suspicious = false;
			let raw = "";
			try {
				const result = await classifyOne(eng, prompt);
				suspicious = result.suspicious;
				raw = result.raw;
			} catch (err) {
				console.error(`[ad-flagger] classify error for #${pkt.id}:`, err);
				raw = String(err);
			}

			if (isEntryStale(entry)) continue;

			const explanation = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || undefined;

			console.log(
				`[ad-flagger] #${pkt.id} <${pkt.tagName}> [${hostname}] → ${suspicious ? "SUSPICIOUS" : "SAFE"}` +
				`\nprompt:\n${prompt}` +
				`\nresponse:\n${explanation ?? "(empty)"}`
			);

			const classification: ClassificationResult = {
				id: pkt.id,
				category: suspicious ? "suspicious" : "benign",
				confidence: suspicious ? "medium" : "low",
				explanation,
			};

			chrome.tabs.sendMessage(tabId, { type: "classificationResult", result: classification }).catch(() => {});

			if (p) {
				p.done++;
				broadcastStatus({ stage: "classifying", total: p.total, done: p.done }, tabId);

				if (p.done >= p.total) {
					tabProgress.delete(tabId);
					tabQueues.delete(tabId);
					broadcastStatus({ stage: "done" }, tabId);
				}
			}
		}
	} finally {
		processingQueue = false;
	}
}

/**
 * Picks the next entry to classify. Preference order: active tab first,
 * then any other tab with pending work.
 */
function pickNext(): QueueEntry | undefined {
	if (activeTabId !== undefined) {
		const q = tabQueues.get(activeTabId);
		if (q && q.length > 0) return q.shift();
	}
	for (const [, q] of tabQueues) {
		if (q.length > 0) return q.shift();
	}
	return undefined;
}

/** True if the entry was enqueued before a model swap or tab cancellation. */
function isEntryStale(entry: QueueEntry): boolean {
	return entry.gen !== generation || (tabGeneration.get(entry.tabId) ?? 0) !== entry.tabGen;
}

export const _testing = { buildPrompt, classifyOne, SYSTEM_PROMPT };