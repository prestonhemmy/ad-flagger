/**
 * Background Service Worker.
 *
 * Acts as central message router providing the "source of truth" for
 * the extension's state.
 *
 * Every cross-context message in the extension flows through this file
 * (hub-and-spoke). Content scripts forward 'EvidencePacket's here for
 * classification, the popup pulls and pushes settings here, and
 * cross-frame highlight relays go through here on their way from a
 * subframe to the top-level document. This shape eliminates a class of
 * cross-frame race conditions that show up in star-topology Chrome
 * extensions.
 *
 * Frame-aware ID assignment: each subframe gets a unique 10000-wide ID
 * block so packet IDs never collide across frames in a single tab.
 */

import { enqueuePackets, setActiveTab, getStatusForTab, setModelId, cancelTab } from "./llm";
import { EvidencePacket, BackgroundMessage, unreachable } from "../shared/types";
import { DEFAULT_MODEL_ID } from "../shared/models";


let nextFrameBlock = 10000;
const FRAME_BLOCK_SIZE = 10000;

interface ClassifyMessage {
	type: "classify";
	packets: EvidencePacket[];
	url?: string;
}

console.log("[ad-flagger] background service worker initialized");

chrome.runtime.onInstalled.addListener((details) => {
	console.log(`[ad-flagger] extension ${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
	console.log("[ad-flagger] browser startup detected");
});

// track active tab for priority queue
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
	if (tabs[0]?.id !== undefined) setActiveTab(tabs[0].id);
});
chrome.tabs.onActivated.addListener((info) => setActiveTab(info.tabId));

/** === Storage Helpers === */

/** Reads all extension settings from chrome.storage.local with sensible defaults. */
async function getSettings(): Promise<{ detectionEnabled: boolean, trustedSites: string[], modelId: string, debugMode: boolean }> {
	return new Promise((resolve) => {
		chrome.storage.local.get(["detectionEnabled", "trustedSites", "modelId", "debugMode"], (result) => {
			resolve({
				detectionEnabled: result["detectionEnabled"] !== false,
				trustedSites: result["trustedSites"] ?? [],
				modelId: result["modelId"] || DEFAULT_MODEL_ID,
				debugMode: result["debugMode"] === true,
			});
		});
	});
}

async function setDetectionEnabled(enabled: boolean): Promise<void> {
	return new Promise((resolve) => {
		chrome.storage.local.set({ detectionEnabled: enabled}, resolve);
	});
}

async function setTrustedSites(sites: string[]): Promise<void> {
	return new Promise((resolve) => {
		chrome.storage.local.set({ trustedSites: sites}, resolve);
	});
}

/** === Content Script Relay Helpers === */

/** Sends a message to the given tab, swallowing the lastError if the tab has no listener. */
async function sendToTab(tabId: number, message: unknown): Promise<unknown> {
	return new Promise((resolve) => {
		chrome.tabs.sendMessage(tabId, message, (response) => {
			if (chrome.runtime.lastError) {
				resolve(undefined);
			} else {
				resolve(response);
			}
		})
	});
}

async function getActiveTabId(): Promise<number | undefined> {
	return new Promise((resolve) => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			resolve(tabs[0]?.id)
		});
	});
}

/** === Central Message Router === */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	const message = msg as BackgroundMessage;
	switch (message.type) {

		/** === Content Script Messages === */

		// handshake: content script asks whether to run for the current hostname,
		// and receives its frame-specific ID offset
		case "contentReady": {
			const hostname: string = message.hostname;
			getSettings().then((settings) => {
				const shouldRun = settings.detectionEnabled && !settings.trustedSites.includes(hostname);

				let idOffset = 0;
				if (sender.frameId !== 0) {
					idOffset = nextFrameBlock;
					nextFrameBlock += FRAME_BLOCK_SIZE;
				}
				sendResponse({ shouldRun, idOffset, debugMode: settings.debugMode });
			});

			return true;
		}

		// content script handing off evidence packets for SLM classification
		case "classify": {
			const { packets, url } = message as ClassifyMessage;
			const tabId = sender.tab?.id;
			if (tabId !== undefined && packets.length > 0) {
				enqueuePackets(packets, url, tabId);
			}
			sendResponse();
			return false;
		}

		// subframe flagged a suspicious element; relay to the top-level frame
		// so the highlight can be drawn on the parent page
		case "iframeFlag": {
			const tabId = sender.tab?.id;

			if (tabId !== undefined) {
				chrome.tabs.sendMessage(
					tabId,
					{
						type: "iframeFlagRelay",
						sourcePacketId: message.packetId,	// TEMP (DEBUGGING)
						explanation: message.explanation,
						sourceURL: sender.url,
					},
					{ frameId: 0 }
				);
			}

			return false;
		}

		/** === Popup Messages === */

		case "getSettings": {
			getSettings().then((settings) => sendResponse(settings));
			return true;
		}

		case "getStatus": {
			const tabId = message.tabId;
			sendResponse(tabId !== undefined ? getStatusForTab(tabId) : { stage: "done" });
			return false;
		}

		case "getDetections": {
			const tabId: number | undefined = message.tabId;
			if (tabId === undefined) {
				sendResponse({count: 0});
				return false;
			}

			chrome.tabs.sendMessage(tabId, {type: "getDetections"}, {frameId: 0}, (response) => {
				if (chrome.runtime.lastError) {
					sendResponse({count: 0});
					return;
				}
				sendResponse({count: (response as any)?.count ?? 0});
			});

			return true;
		}

		case "setDetectionEnabled": {
			const enabled: boolean = message.enabled;

			(async () => {
				await setDetectionEnabled(enabled);

				const tabId = message.tabId ?? (await getActiveTabId());
				if (tabId !== undefined) {
					// only re-enable if the site isn't trusted
					let shouldRun = enabled;
					if (enabled) {
						const tab = await chrome.tabs.get(tabId);

						const hostname = tab.url ? new URL(tab.url).hostname : null;
						const settings = await getSettings();
						if (hostname && settings.trustedSites.includes(hostname)) {
							shouldRun = false;
						}
					}
					await sendToTab(tabId, {type: "detectionToggle", enabled: shouldRun});
				}

				sendResponse({ok: true});
			})();

			return true;
		}

		case "setTrustSite": {
			const hostname: string = message.hostname;
			const trusted: boolean = message.trusted;

			if (trusted && message.tabId !== undefined) cancelTab(message.tabId);

			(async () => {
				const settings = await getSettings();
				const updated = trusted ? [...new Set([...settings.trustedSites, hostname])]
					: settings.trustedSites.filter((h) => h !== hostname);

				await setTrustedSites(updated);

				const tabId = message.tabId ?? (await getActiveTabId());
				if (tabId !== undefined) {
					// only re-enable if detection is globally enabled
					const shouldRun = !trusted && settings.detectionEnabled;
					await sendToTab(tabId, {type: "detectionToggle", enabled: shouldRun});
				}

				sendResponse({ok: true});
			})();

			return true;
		}

		case "setModel": {
			const modelId: string = message.modelId;
			chrome.storage.local.set({ modelId });

			(async () => {
				await setModelId(modelId);

				// re-run detection on the active tab with the new model
				const tabId = await getActiveTabId();
				if (tabId !== undefined) {
					const settings = await getSettings();
					const tab = await chrome.tabs.get(tabId);
					const hostname = tab.url ? new URL(tab.url).hostname : null;
					const shouldRun = settings.detectionEnabled
						&& !(hostname && settings.trustedSites.includes(hostname));

					await sendToTab(tabId, { type: "detectionToggle", enabled: false });
					if (shouldRun) {
						await sendToTab(tabId, { type: "detectionToggle", enabled: true });
					}
				}

				sendResponse({ ok: true });
			})();

			return true;
		}

		case "setDebugMode": {
			const enabled: boolean = message.enabled;
			chrome.storage.local.set({ debugMode: enabled });

			(async () => {
				const tabId = message.tabId ?? (await getActiveTabId());
				if (tabId !== undefined) {
					await sendToTab(tabId, { type: "setDebugMode", enabled });
				}
				sendResponse({ ok: true });
			})();

			return true;
		}

		default:
			unreachable(message);
			return false;
	}
});