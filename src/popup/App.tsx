/**
 * Popup UI.
 *
 * Renders the extension's settings panel (detection toggle, trusted-site
 * toggle, model picker, debug toggle) and a live status line driven by
 * 'statusUpdate' broadcasts from the background service worker.
 *
 * The popup never messages the content script directly. Every read and
 * write goes through the background worker per the hub-and-spoke
 * architecture.
 */


import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MODEL_GROUPS, DEFAULT_MODEL_ID, suggestModelId } from "../shared/models";
import "./index.css";

type PipelineStatus =
	| { stage: "loading"; modelId: string; progress: number }
	| { stage: "classifying"; total: number; done: number }
	| { stage: "done"; flagged: number };

/**
 * Probes the WebGPU adapter for its maxBufferSize, used to suggest a model
 * that will fit in available VRAM. Returns 0 if WebGPU is unavailable.
 */
async function getMaxBufferSizeMB(): Promise<number> {
	try {
		const gpu = (navigator as any).gpu;
		if (!gpu) return 0;
		const adapter = await gpu.requestAdapter();
		if (!adapter) return 0;
		return adapter.limits.maxBufferSize / (1024 * 1024);
	} catch {
		return 0;
	}
}

/** Small switch component used for each boolean setting. */
function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
	return (
		<label className="flex items-center justify-between cursor-pointer">
			<span className="text-sm text-gray-600">{label}</span>
			<button
				type="button"
				role="switch"
				aria-checked={on}
				onClick={() => onChange(!on)}
				className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-blue-500" : "bg-gray-300"}`}
			>
				<span
					className={`pointer-events-none inline-block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4.5" : "translate-x-0.5"}`}
				/>
			</button>
		</label>
	);
}

/** Renders the active pipeline stage (loading / scanning / done). */
function StatusLine({ status }: { status: PipelineStatus }) {
	switch (status.stage) {
		case "loading": {
			const pct = Math.round(status.progress * 100);
			const name = status.modelId.split("-").slice(0, 2).join("-");
			return (
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
					<span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse" />
					Loading {name} ({pct}%)
				</span>
			);
		}
		case "classifying":
			return (
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
					<span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse" />
					Scanning {status.done} of {status.total} elements…
				</span>
			);
		case "done":
			return status.flagged > 0 ? (
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600">
					<span className="w-1.5 h-1.5 rounded-full bg-red-500" />
					{status.flagged} suspicious element{status.flagged !== 1 && "s"} found
				</span>
			) : (
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600">
					<span className="w-1.5 h-1.5 rounded-full bg-green-500" />
					Page looks safe
				</span>
			);
	}
}

function App() {
	const [status, setStatus] = useState<PipelineStatus>({ stage: "done", flagged: 0 });
	const [detectionEnabled, setDetectionEnabled] = useState(true);
	const [trustThisSite, setTrustThisSite] = useState(false);
	const [currentHostname, setCurrentHostname] = useState<string | null>(null);
	const [activeTabId, setActiveTabId] = useState<number | undefined>();
	const [settingsLoaded, setSettingsLoaded] = useState(false);
	const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
	const [debugModeEnabled, setDebugModeEnabled] = useState(false);

	// On mount, subscribe to status updates, fetch settings, fetch current
	// pipeline status, and (if no model is stored yet) suggest one based on
	// available WebGPU VRAM.
	useEffect(() => {
		const gpuProbe = getMaxBufferSizeMB();

		let tabId: number | undefined;
		const listener = (message: { type: string; status: PipelineStatus; tabId?: number }) => {
			if (message.type === "statusUpdate" && (message.tabId === undefined || message.tabId === tabId)) {
				if (message.status.stage === "done" && tabId !== undefined) {
					chrome.runtime.sendMessage({ type: "getDetections", tabId }, (response) => {
						if (chrome.runtime.lastError) {
							setStatus({ stage: "done", flagged: 0 });
							return;
						}
						setStatus({ stage: "done", flagged: response?.count ?? 0 });
					});
				} else {
					setStatus(message.status);
				}
			}
		};
		chrome.runtime.onMessage.addListener(listener);

		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const tab = tabs[0];
			tabId = tab?.id;
			setActiveTabId(tabId);

			const hostname = tab?.url ? new URL(tab.url).hostname : null;
			setCurrentHostname(hostname);

			// fetch detection-enabled and trusted-site settings from the background worker
			chrome.runtime.sendMessage({ type: "getSettings" }, (settings) => {
				if (chrome.runtime.lastError) {
					setSettingsLoaded(true);
					return;
				}

				setDetectionEnabled(settings?.detectionEnabled !== false);
				setDebugModeEnabled(settings?.debugMode === true);
				const trusted: string[] = settings?.trustedSites ?? [];
				setTrustThisSite(hostname !== null && trusted.includes(hostname));

				gpuProbe.then(maxBufferMB => {
					if (settings?.modelId) {
						setSelectedModel(settings.modelId);
					} else {
						const pick = maxBufferMB > 0 ? suggestModelId(maxBufferMB) : DEFAULT_MODEL_ID;
						setSelectedModel(pick);
						chrome.runtime.sendMessage({ type: "setModel", modelId: pick });
					}

					setSettingsLoaded(true);
				});
			});

			// fetch current pipeline status for this tab from the background worker
			if (tabId !== undefined) {
				chrome.runtime.sendMessage({ type: "getStatus", tabId: tabId }, (response) => {
					if (chrome.runtime.lastError) return;
					if (response.stage === "done") {
						chrome.runtime.sendMessage({ type: "getDetections", tabId }, (detResponse) => {
							if (chrome.runtime.lastError) {
								setStatus({ stage: "done", flagged: 0 });
								return;
							}
							setStatus({ stage: "done", flagged: detResponse?.count ?? 0 });
						});
					} else {
						setStatus(response);
					}
				});
			}
		});

		return () => chrome.runtime.onMessage.removeListener(listener);
	}, []);

	function handleDetectionEnabled(value: boolean) {
		setDetectionEnabled(value);
		chrome.runtime.sendMessage({
			type: "setDetectionEnabled",
			enabled: value,
			tabId: activeTabId,
		});
	}

	function handleTrustThisSite(value: boolean) {
		setTrustThisSite(value);
		if (value) setStatus({ stage: "done", flagged: 0 });

		chrome.runtime.sendMessage({
			type: "setTrustSite",
			hostname: currentHostname,
			trusted: value,
			tabId: activeTabId,
		});
	}

	function handleModelChange(modelId: string) {
		setSelectedModel(modelId);
		setStatus({ stage: "loading", modelId, progress: 0 });
		chrome.runtime.sendMessage({ type: "setModel", modelId });
	}

	function handleDebugMode(value: boolean) {
		setDebugModeEnabled(value);
		chrome.runtime.sendMessage({
			type: "setDebugMode",
			enabled: value,
			tabId: activeTabId,
		});
	}

	return (
		<div className="w-[280px] bg-white font-sans">
			<div className="px-4 py-3 border-b border-gray-100">
				<h1 className="text-xs font-bold text-gray-500 tracking-wide uppercase">Deceptive Ad Flagger</h1>
			</div>

			<div className="px-4 py-3 border-b border-gray-100">
				<StatusLine status={status} />
			</div>

			{settingsLoaded && (
				<div className="px-4 py-2.5 flex flex-col gap-2.5">
					<label className="flex flex-col gap-1">
						<span className="text-sm text-gray-600">Model</span>
						<select
							value={selectedModel}
							onChange={(e) => handleModelChange(e.target.value)}
							className="text-xs bg-white border border-gray-200 rounded px-2 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
						>
							{MODEL_GROUPS.map((group) => (
								<optgroup key={group.label} label={group.label}>
									{group.models.map((m) => (
										<option key={m.id} value={m.id}>
											{m.name} — {(m.vramMB / 1024).toFixed(1)} GB{m.id.startsWith("Qwen3-") ? " (recommended)" : ""}
										</option>
									))}
								</optgroup>
							))}
						</select>
					</label>
					<Toggle label="Enable detection" on={detectionEnabled} onChange={handleDetectionEnabled} />
					<Toggle label="Trust this site" on={trustThisSite} onChange={handleTrustThisSite} />
					<Toggle label="Debug mode" on={debugModeEnabled} onChange={handleDebugMode} />
				</div>
			)}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<App />);