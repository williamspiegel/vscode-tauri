/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { installDesktopSandbox } from "./desktopSandbox";
import { HostClient, HostHttpRequest, HostHttpResponse } from "./hostClient";
import type { HostEventName, HostEventPayload } from "./hostProtocol";

type StatusLevel = "info" | "error";
type StartupStepTiming = {
	label: string;
	durationMs: number;
};
type StartupLongTaskTiming = {
	name: string;
	startTime: number;
	duration: number;
};
type StartupResourceTiming = {
	name: string;
	initiatorType: string;
	startTime: number;
	duration: number;
	transferSize?: number;
};
type StartupPhaseDurations = {
	windowConfig?: number;
	cssLoader?: number;
	workbenchMainImport?: number;
	sharedProcessConnect?: number;
	postMainToRender?: number;
};
type StartupProfileReport = {
	totalStartupMs: number;
	firstRenderWaitMs: number;
	loadedWorkbenchPath: string;
	phases: StartupPhaseDurations;
	steps: StartupStepTiming[];
	longTasks: StartupLongTaskTiming[];
	topResources: StartupResourceTiming[];
	workbenchImportResources: StartupResourceTiming[];
	fallbackCounts?: Record<string, number>;
};

const SOURCEMAP_WARNING_PATTERN =
	/Sourcemap for ".*" points to missing source files/;
const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
	if (
		args.some(
			(value) =>
				typeof value === "string" && SOURCEMAP_WARNING_PATTERN.test(value),
		)
	) {
		return;
	}
	originalConsoleWarn(...args);
};

function setStatus(
	message: string,
	level: StatusLevel = "info",
	visible = true,
): void {
	const status = document.getElementById("status");
	if (status) {
		status.textContent = message;
		status.dataset.level = level;
		status.dataset.visible = visible ? "1" : "0";
	}
}

function isWorkbenchRendered(): boolean {
	return !!document.querySelector(".monaco-workbench");
}

function waitForWorkbenchRender(timeoutMs = 15000): Promise<boolean> {
	if (isWorkbenchRendered()) {
		return Promise.resolve(true);
	}

	return new Promise((resolve) => {
		const deadline = window.setTimeout(() => {
			observer.disconnect();
			resolve(isWorkbenchRendered());
		}, timeoutMs);

		const observer = new MutationObserver(() => {
			if (!isWorkbenchRendered()) {
				return;
			}

			window.clearTimeout(deadline);
			observer.disconnect();
			resolve(true);
		});

		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
	});
}

function shouldShowVerboseStartupStatus(): boolean {
	return (
		new URLSearchParams(window.location.search).get("hostDebug") === "1" ||
		(() => {
			try {
				return window.localStorage?.getItem("tauriHostDebug") === "1";
			} catch {
				return false;
			}
		})()
	);
}

function shouldEnableStartupProfile(): boolean {
	const queryValue = new URLSearchParams(window.location.search).get(
		"startupProfile",
	);
	if (queryValue === "1" || queryValue === "true" || queryValue === "on") {
		return true;
	}
	if (queryValue === "0" || queryValue === "false" || queryValue === "off") {
		return false;
	}

	try {
		return window.localStorage?.getItem("tauriStartupProfile") === "1";
	} catch {
		return false;
	}
}

function shouldAutoDownloadStartupProfile(): boolean {
	const queryValue = new URLSearchParams(window.location.search).get(
		"startupProfile",
	);
	if (queryValue === "download") {
		return true;
	}

	try {
		return window.localStorage?.getItem("tauriStartupProfileDownload") === "1";
	} catch {
		return false;
	}
}

const WORKBENCH_BOOTSTRAP_QUERY_KEY = "workbenchBundle";
const LEGACY_RETRY_QUERY_KEY = "tauriLegacyRetry";
const LEGACY_WORKBENCH_BOOTSTRAP_PATH =
	"/out/vs/code/electron-browser/workbench/workbench.js";
const MIN_WORKBENCH_BOOTSTRAP_PATH =
	"/out-vscode-min/vs/code/electron-browser/workbench/workbench.js";
const WORKBENCH_BOOTSTRAP_SUFFIX =
	"/vs/code/electron-browser/workbench/workbench.js";
const WORKBENCH_DESKTOP_MAIN_SUFFIX = "/vs/workbench/workbench.desktop.main.js";
const BOOTSTRAP_STATE_STORAGE_KEY = "tauriWorkbenchBootstrapState";

type WorkbenchBootstrapConfig = {
	primaryPath?: string;
	fallbackPath?: string;
	preferredBundle?: string;
	buildId?: string;
};

type WorkbenchBootstrapState = {
	buildId?: string;
	lastAttemptPath?: string;
	lastGoodPath?: string;
	failedPath?: string;
	failedCount?: number;
};

let startupBootstrapBuildId = "unknown";
let startupPhaseActive = true;
let startupRecoveryTriggered = false;
let startupCurrentAttemptPath: string | undefined;

function isHttpOrigin(): boolean {
	return (
		window.location.protocol === "http:" ||
		window.location.protocol === "https:"
	);
}

function canonicalizeBootstrapPath(
	path: string | undefined,
): string | undefined {
	if (!path) {
		return undefined;
	}
	if (
		path.includes(
			"/out-vscode-min/vs/code/electron-browser/workbench/workbench.js",
		)
	) {
		return MIN_WORKBENCH_BOOTSTRAP_PATH;
	}
	if (path.includes("/out/vs/code/electron-browser/workbench/workbench.js")) {
		return LEGACY_WORKBENCH_BOOTSTRAP_PATH;
	}
	return path;
}

function isValidBootstrapPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		(value.startsWith("/out/") || value.startsWith("/out-vscode-min/"))
	);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

type GlobalWithHostFetchFallback = typeof globalThis & {
	__TAURI_HOST_FETCH_FALLBACK_INSTALLED__?: boolean;
};

const HOST_FETCH_TRACE_ENABLED = (() => {
	const search = new URLSearchParams(window.location.search);
	const queryValue = search.get("hostFetchTrace");
	if (queryValue === "1" || queryValue === "true" || queryValue === "on") {
		return true;
	}
	if (queryValue === "0" || queryValue === "false" || queryValue === "off") {
		return false;
	}

	if (search.get("hostDebug") === "1") {
		return true;
	}

	try {
		const stored = window.localStorage?.getItem("tauriHostFetchTrace");
		if (stored === "1" || stored === "true" || stored === "on") {
			return true;
		}
		if (stored === "0" || stored === "false" || stored === "off") {
			return false;
		}

		return window.localStorage?.getItem("tauriHostDebug") === "1";
	} catch {
		return false;
	}
})();

let hostFetchRequestCounter = 0;

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		const parts: string[] = [];
		if (error.name) {
			parts.push(error.name);
		}
		if (error.message) {
			parts.push(error.message);
		}
		return parts.join(": ");
	}
	return String(error);
}

function shouldTraceHostFetchUrl(url: string | undefined): boolean {
	if (!HOST_FETCH_TRACE_ENABLED || !url) {
		return false;
	}

	try {
		const parsed = new URL(url, window.location.href);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function encodeBytesToBase64(bytes: Uint8Array): string {
	if (bytes.byteLength === 0) {
		return "";
	}

	let binary = "";
	const chunkSize = 0x8000;
	for (let index = 0; index < bytes.byteLength; index += chunkSize) {
		const chunk = bytes.subarray(index, index + chunkSize);
		let chunkBinary = "";
		for (const value of chunk) {
			chunkBinary += String.fromCharCode(value);
		}
		binary += chunkBinary;
	}
	return btoa(binary);
}

function decodeBase64ToBytes(value: string): Uint8Array {
	if (!value) {
		return new Uint8Array(0);
	}

	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index) & 0xff;
	}
	return bytes;
}

function resolveFetchUrl(input: RequestInfo | URL): string | undefined {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	return undefined;
}

function resolveFetchMethod(
	input: RequestInfo | URL,
	init?: RequestInit,
): string {
	const method =
		init?.method ??
		(input instanceof Request ? input.method : undefined) ??
		"GET";
	return method.toUpperCase();
}

function mergeHeadersIntoRecord(
	target: Record<string, string | string[]>,
	source: HeadersInit | undefined,
): void {
	if (!source) {
		return;
	}
	const headers = new Headers(source);
	headers.forEach((value, key) => {
		const existing = target[key];
		if (typeof existing === "undefined") {
			target[key] = value;
			return;
		}
		if (Array.isArray(existing)) {
			existing.push(value);
			return;
		}
		target[key] = [existing, value];
	});
}

function collectFetchHeaders(
	input: RequestInfo | URL,
	init?: RequestInit,
): Record<string, string | string[]> {
	const headers: Record<string, string | string[]> = {};
	if (input instanceof Request) {
		mergeHeadersIntoRecord(headers, input.headers);
	}
	mergeHeadersIntoRecord(headers, init?.headers);
	return headers;
}

async function resolveRequestBodyBase64(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<string | undefined> {
	const body = typeof init?.body !== "undefined" ? init.body : undefined;
	if (typeof body === "string") {
		return encodeBytesToBase64(new TextEncoder().encode(body));
	}
	if (body instanceof URLSearchParams) {
		return encodeBytesToBase64(new TextEncoder().encode(body.toString()));
	}
	if (body instanceof Blob) {
		return encodeBytesToBase64(new Uint8Array(await body.arrayBuffer()));
	}
	if (body instanceof ArrayBuffer) {
		return encodeBytesToBase64(new Uint8Array(body));
	}
	if (ArrayBuffer.isView(body)) {
		return encodeBytesToBase64(
			new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
		);
	}

	if (body == null && input instanceof Request && !input.bodyUsed) {
		try {
			const cloned = input.clone();
			const requestBody = await cloned.arrayBuffer();
			if (requestBody.byteLength > 0) {
				return encodeBytesToBase64(new Uint8Array(requestBody));
			}
		} catch {
			// Ignore body extraction failures and continue without a body.
		}
	}

	return undefined;
}

function isLikelyCrossOriginFetchFailure(url: string, error: unknown): boolean {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url, window.location.href);
	} catch {
		return false;
	}

	if (!/^https?:$/.test(parsedUrl.protocol)) {
		return false;
	}
	if (parsedUrl.origin === window.location.origin) {
		return false;
	}

	if (error instanceof DOMException && error.name === "AbortError") {
		return false;
	}
	if (!(error instanceof Error)) {
		return false;
	}
	if (error.name === "AbortError" || error.name === "TimeoutError") {
		return false;
	}
	if (error.name === "TypeError") {
		return true;
	}

	const message = error.message.toLowerCase();
	return (
		message.includes("failed to fetch") ||
		message.includes("networkerror") ||
		message.includes("load failed")
	);
}

function responseHeadersFromHost(
	headers: Record<string, string | string[]>,
): Headers {
	const out = new Headers();
	for (const [key, rawValue] of Object.entries(headers ?? {})) {
		if (Array.isArray(rawValue)) {
			for (const value of rawValue) {
				out.append(key, value);
			}
		} else if (typeof rawValue === "string") {
			out.append(key, rawValue);
		}
	}
	return out;
}

async function fetchViaHost(
	host: HostClient,
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const url = resolveFetchUrl(input);
	if (!url) {
		throw new Error("Unable to resolve request URL for host fallback.");
	}
	const trace = shouldTraceHostFetchUrl(url);
	const requestId = ++hostFetchRequestCounter;

	const request: HostHttpRequest = {
		url,
		method: resolveFetchMethod(input, init),
		headers: collectFetchHeaders(input, init),
	};
	const bodyBase64 = await resolveRequestBodyBase64(input, init);
	if (typeof bodyBase64 === "string") {
		request.bodyBase64 = bodyBase64;
	}

	const startedAt = performance.now();
	if (trace) {
		const headerCount = Object.keys(request.headers ?? {}).length;
		console.info("[tauri.hostFetch] -> host.httpRequest", {
			requestId,
			method: request.method,
			url,
			hasBody:
				typeof request.bodyBase64 === "string" && request.bodyBase64.length > 0,
			headerCount,
		});
	}

	const response = await host.httpRequest(request);
	const hostResponse = response as HostHttpResponse;
	const status = Number.isInteger(hostResponse.statusCode)
		? hostResponse.statusCode
		: 500;
	const normalizedStatus = status >= 200 && status <= 599 ? status : 500;
	const bodyBytes = decodeBase64ToBytes(hostResponse.bodyBase64 ?? "");
	const body = new Uint8Array(bodyBytes.byteLength);
	body.set(bodyBytes);
	if (trace) {
		console.info("[tauri.hostFetch] <- host.httpRequest", {
			requestId,
			url,
			status: normalizedStatus,
			bodyBytes: body.byteLength,
			elapsedMs: Math.round(performance.now() - startedAt),
		});
	}
	return new Response(body.buffer, {
		status: normalizedStatus,
		headers: responseHeadersFromHost(hostResponse.headers ?? {}),
	});
}

function installHostFetchFallback(host: HostClient): void {
	const globalWithFlag = globalThis as GlobalWithHostFetchFallback;
	if (globalWithFlag.__TAURI_HOST_FETCH_FALLBACK_INSTALLED__) {
		return;
	}
	if (typeof globalThis.fetch !== "function") {
		return;
	}

	const originalFetch = globalThis.fetch.bind(globalThis);
	globalWithFlag.__TAURI_HOST_FETCH_FALLBACK_INSTALLED__ = true;
	if (HOST_FETCH_TRACE_ENABLED) {
		console.info("[tauri.hostFetch] fallback shim installed");
	}

	globalThis.fetch = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url = resolveFetchUrl(input);
		const trace = shouldTraceHostFetchUrl(url);
		try {
			const response = await originalFetch(input, init);
			if (trace) {
				console.info("[tauri.hostFetch] browser fetch success", {
					url,
					status: response.status,
				});
			}
			return response;
		} catch (error) {
			if (!url || !isLikelyCrossOriginFetchFailure(url, error)) {
				if (trace) {
					console.warn(
						"[tauri.hostFetch] browser fetch failed without host fallback",
						{
							url,
							error: formatUnknownError(error),
						},
					);
				}
				throw error;
			}
			if (trace) {
				console.warn(
					"[tauri.hostFetch] browser fetch failed, retrying via host",
					{
						url,
						error: formatUnknownError(error),
					},
				);
			}
			try {
				return await fetchViaHost(host, input, init);
			} catch (hostError) {
				if (trace) {
					console.error("[tauri.hostFetch] host fallback failed", {
						url,
						error: formatUnknownError(hostError),
					});
				}
				throw hostError;
			}
		}
	};
}

function readBootstrapState(): WorkbenchBootstrapState {
	try {
		const raw = window.localStorage?.getItem(BOOTSTRAP_STATE_STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = asRecord(JSON.parse(raw));
		return {
			buildId: typeof parsed.buildId === "string" ? parsed.buildId : undefined,
			lastAttemptPath: canonicalizeBootstrapPath(
				typeof parsed.lastAttemptPath === "string"
					? parsed.lastAttemptPath
					: undefined,
			),
			lastGoodPath: canonicalizeBootstrapPath(
				typeof parsed.lastGoodPath === "string"
					? parsed.lastGoodPath
					: undefined,
			),
			failedPath: canonicalizeBootstrapPath(
				typeof parsed.failedPath === "string" ? parsed.failedPath : undefined,
			),
			failedCount:
				typeof parsed.failedCount === "number" ? parsed.failedCount : undefined,
		};
	} catch {
		return {};
	}
}

function writeBootstrapState(next: WorkbenchBootstrapState): void {
	try {
		window.localStorage?.setItem(
			BOOTSTRAP_STATE_STORAGE_KEY,
			JSON.stringify(next),
		);
	} catch {
		// ignore storage write failures
	}
}

function markBootstrapAttempt(buildId: string, path: string): void {
	const canonicalPath = canonicalizeBootstrapPath(path) ?? path;
	startupCurrentAttemptPath = canonicalPath;
	const state = readBootstrapState();
	writeBootstrapState({
		...state,
		buildId,
		lastAttemptPath: canonicalPath,
	});
}

function markBootstrapFailure(buildId: string, path: string): void {
	const canonicalPath = canonicalizeBootstrapPath(path) ?? path;
	if (startupCurrentAttemptPath === canonicalPath) {
		startupCurrentAttemptPath = undefined;
	}
	const state = readBootstrapState();
	const priorFailures =
		state.failedPath === canonicalPath ? (state.failedCount ?? 0) : 0;
	writeBootstrapState({
		...state,
		buildId,
		failedPath: canonicalPath,
		failedCount: priorFailures + 1,
	});
}

function markBootstrapSuccess(buildId: string, path: string): void {
	const canonicalPath = canonicalizeBootstrapPath(path) ?? path;
	if (startupCurrentAttemptPath === canonicalPath) {
		startupCurrentAttemptPath = undefined;
	}
	const state = readBootstrapState();
	writeBootstrapState({
		...state,
		buildId,
		lastGoodPath: canonicalPath,
		lastAttemptPath: undefined,
		failedPath:
			state.failedPath === canonicalPath ? undefined : state.failedPath,
		failedCount:
			state.failedPath === canonicalPath ? undefined : state.failedCount,
	});
}

function toFileUrlFromAppRoot(
	appRoot: string,
	pathFromAppRoot: string,
): string {
	const root = appRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	const absoluteRoot = root.startsWith("/") ? root : `/${root}`;
	const suffix = pathFromAppRoot.startsWith("/")
		? pathFromAppRoot
		: `/${pathFromAppRoot}`;
	return encodeURI(`file://${absoluteRoot}${suffix}`).replace(/#/g, "%23");
}

function createOutModuleCandidates(
	appRoot: string,
	modulePathFromOut: string,
): string[] {
	const normalized = modulePathFromOut.startsWith("/")
		? modulePathFromOut
		: `/${modulePathFromOut}`;
	const candidates = new Set<string>([`/out${normalized}`]);
	if (appRoot) {
		if (isHttpOrigin()) {
			candidates.add(`/@fs${appRoot}/out${normalized}`);
		} else {
			candidates.add(toFileUrlFromAppRoot(appRoot, `/out${normalized}`));
		}
	}

	return [...candidates];
}

function getWorkbenchDesktopMainPath(workbenchBootstrapPath: string): string {
	if (workbenchBootstrapPath.endsWith(WORKBENCH_BOOTSTRAP_SUFFIX)) {
		return `${workbenchBootstrapPath.slice(0, -WORKBENCH_BOOTSTRAP_SUFFIX.length)}${WORKBENCH_DESKTOP_MAIN_SUFFIX}`;
	}

	if (workbenchBootstrapPath.includes("/out-vscode-min/")) {
		return "/out-vscode-min/vs/workbench/workbench.desktop.main.js";
	}

	return "/out/vs/workbench/workbench.desktop.main.js";
}

function resolveHostWorkbenchBootstrapConfig(
	windowConfig: Record<string, unknown>,
): WorkbenchBootstrapConfig {
	const bootstrap = asRecord(windowConfig.workbenchBootstrap);
	return {
		primaryPath: isValidBootstrapPath(bootstrap.primaryPath)
			? bootstrap.primaryPath
			: undefined,
		fallbackPath: isValidBootstrapPath(bootstrap.fallbackPath)
			? bootstrap.fallbackPath
			: undefined,
		preferredBundle:
			typeof bootstrap.preferredBundle === "string"
				? bootstrap.preferredBundle
				: undefined,
		buildId:
			typeof bootstrap.buildId === "string" && bootstrap.buildId.length > 0
				? bootstrap.buildId
				: undefined,
	};
}

function expandBootstrapCandidates(appRoot: string, path: string): string[] {
	const out = new Set<string>([path]);
	if (!path.startsWith("/")) {
		return [...out];
	}
	const isKnownWorkbenchPath =
		path.startsWith("/out/") || path.startsWith("/out-vscode-min/");
	if (isHttpOrigin()) {
		if (isKnownWorkbenchPath) {
			return [...out];
		}
		if (appRoot) {
			out.add(`/@fs${appRoot}${path}`);
		}
	} else if (appRoot) {
		out.add(toFileUrlFromAppRoot(appRoot, path));
	}
	return [...out];
}

function moveCandidateToFront(
	candidates: string[],
	preferredPath: string,
): string[] {
	const index = candidates.indexOf(preferredPath);
	if (index <= 0) {
		return candidates;
	}
	const reordered = candidates.slice();
	const [entry] = reordered.splice(index, 1);
	reordered.unshift(entry);
	return reordered;
}

function moveCandidateToBack(
	candidates: string[],
	deprioritizedPath: string,
): string[] {
	const index = candidates.indexOf(deprioritizedPath);
	if (index < 0 || index === candidates.length - 1) {
		return candidates;
	}
	const reordered = candidates.slice();
	const [entry] = reordered.splice(index, 1);
	reordered.push(entry);
	return reordered;
}

function resolveWorkbenchBootstrapCandidates(
	appRoot: string,
	windowConfig: Record<string, unknown>,
): string[] {
	const searchParams = new URLSearchParams(window.location.search);
	const bundleOverride = searchParams.get(WORKBENCH_BOOTSTRAP_QUERY_KEY);
	const hostBootstrap = resolveHostWorkbenchBootstrapConfig(windowConfig);
	const buildId = hostBootstrap.buildId ?? "unknown";
	startupBootstrapBuildId = buildId;
	const primaryPath =
		hostBootstrap.primaryPath ?? LEGACY_WORKBENCH_BOOTSTRAP_PATH;
	const fallbackPath =
		hostBootstrap.fallbackPath ??
		(primaryPath === MIN_WORKBENCH_BOOTSTRAP_PATH
			? LEGACY_WORKBENCH_BOOTSTRAP_PATH
			: MIN_WORKBENCH_BOOTSTRAP_PATH);
	const legacyCandidates = expandBootstrapCandidates(
		appRoot,
		LEGACY_WORKBENCH_BOOTSTRAP_PATH,
	);
	const minCandidates = expandBootstrapCandidates(
		appRoot,
		MIN_WORKBENCH_BOOTSTRAP_PATH,
	);
	const dedupe = (values: string[]): string[] => [...new Set(values)];

	if (bundleOverride === "legacy") {
		return dedupe([...legacyCandidates, ...minCandidates]);
	}
	if (bundleOverride === "min") {
		return dedupe([...minCandidates, ...legacyCandidates]);
	}

	let candidates = dedupe([
		...expandBootstrapCandidates(appRoot, primaryPath),
		...expandBootstrapCandidates(appRoot, fallbackPath),
		...legacyCandidates,
		...minCandidates,
	]);
	const state = readBootstrapState();
	if (state.buildId === buildId && typeof state.lastGoodPath === "string") {
		candidates = moveCandidateToFront(candidates, state.lastGoodPath);
	}
	if (state.buildId === buildId && typeof state.failedPath === "string") {
		candidates = moveCandidateToBack(candidates, state.failedPath);
	}
	return candidates;
}

function shouldAutoRetryWithLegacy(lastAttemptPath: string): boolean {
	const canonical =
		canonicalizeBootstrapPath(lastAttemptPath) ?? lastAttemptPath;
	if (!canonical.includes("/out-vscode-min/")) {
		return false;
	}
	const searchParams = new URLSearchParams(window.location.search);
	if (searchParams.get(WORKBENCH_BOOTSTRAP_QUERY_KEY) === "min") {
		return false;
	}
	if (searchParams.get(LEGACY_RETRY_QUERY_KEY) === "1") {
		return false;
	}
	return true;
}

function redirectToLegacyRetry(): void {
	const url = new URL(window.location.href);
	url.searchParams.set(WORKBENCH_BOOTSTRAP_QUERY_KEY, "legacy");
	url.searchParams.set(LEGACY_RETRY_QUERY_KEY, "1");
	window.location.replace(url.toString());
}

function tryRecoverStartupWithLegacy(reason: string): boolean {
	if (!startupPhaseActive || startupRecoveryTriggered) {
		return false;
	}
	const bootstrapState =
		typeof startupCurrentAttemptPath === "string"
			? undefined
			: readBootstrapState();
	const lastAttemptPath =
		startupCurrentAttemptPath ??
		(typeof bootstrapState?.lastAttemptPath === "string"
			? bootstrapState.lastAttemptPath
			: "");
	if (!lastAttemptPath || !shouldAutoRetryWithLegacy(lastAttemptPath)) {
		return false;
	}
	startupRecoveryTriggered = true;
	markBootstrapFailure(startupBootstrapBuildId, lastAttemptPath);
	console.warn(
		"[startup] retrying with legacy bundle after startup runtime failure",
		{
			reason,
			failedPath: lastAttemptPath,
		},
	);
	redirectToLegacyRetry();
	return true;
}

function installWorkbenchModulePreloadHints(
	workbenchBootstrapCandidates: readonly string[],
): void {
	if (!isHttpOrigin()) {
		return;
	}

	const moduleUrls = new Set<string>();
	const primaryBootstrapPath = workbenchBootstrapCandidates[0];
	if (primaryBootstrapPath) {
		moduleUrls.add(primaryBootstrapPath);
		moduleUrls.add(getWorkbenchDesktopMainPath(primaryBootstrapPath));
	}

	for (const moduleUrl of moduleUrls) {
		const href = new URL(moduleUrl, window.location.origin).toString();
		if (
			document.head.querySelector(`link[rel="modulepreload"][href="${href}"]`)
		) {
			continue;
		}

		const preload = document.createElement("link");
		preload.rel = "modulepreload";
		preload.href = href;
		document.head.appendChild(preload);
	}
}

function getLatestPerformanceMark(name: string): number | undefined {
	const entries = performance.getEntriesByName(name, "mark");
	if (entries.length === 0) {
		return undefined;
	}

	return entries[entries.length - 1].startTime;
}

function getDurationFromMarks(
	startMark: string,
	endMark: string,
): number | undefined {
	const start = getLatestPerformanceMark(startMark);
	const end = getLatestPerformanceMark(endMark);
	if (typeof start !== "number" || typeof end !== "number" || end < start) {
		return undefined;
	}

	return Math.round(end - start);
}

function getStartupPhaseDurations(): StartupPhaseDurations {
	return {
		windowConfig: getDurationFromMarks(
			"code/willWaitForWindowConfig",
			"code/didWaitForWindowConfig",
		),
		cssLoader: getDurationFromMarks(
			"code/willAddCssLoader",
			"code/didAddCssLoader",
		),
		workbenchMainImport: getDurationFromMarks(
			"code/willLoadWorkbenchMain",
			"code/didLoadWorkbenchMain",
		),
		sharedProcessConnect: getDurationFromMarks(
			"code/willConnectSharedProcess",
			"code/didConnectSharedProcess",
		),
		postMainToRender: getDurationFromMarks(
			"code/didLoadWorkbenchMain",
			"tauri/workbenchFirstRender",
		),
	};
}

function logStartupBreakdown(waitDurationMs: number): void {
	const phaseDurations = getStartupPhaseDurations();

	const formatted = Object.entries(phaseDurations)
		.map(
			([phase, ms]) => `${phase}=${typeof ms === "number" ? `${ms}ms` : "n/a"}`,
		)
		.join(" ");

	console.info(`[startup.breakdown] wait=${waitDurationMs}ms ${formatted}`);
}

function collectTopStartupResources(limit = 25): StartupResourceTiming[] {
	return performance
		.getEntriesByType("resource")
		.filter(
			(entry): entry is PerformanceResourceTiming =>
				entry instanceof PerformanceResourceTiming,
		)
		.filter((entry) => {
			return (
				entry.name.includes("/out/") ||
				entry.name.includes("/out-vscode-min/") ||
				entry.name.includes("/@fs/") ||
				entry.initiatorType === "script"
			);
		})
		.sort((left, right) => right.duration - left.duration)
		.slice(0, limit)
		.map((entry) => ({
			name: entry.name,
			initiatorType: entry.initiatorType,
			startTime: Math.round(entry.startTime),
			duration: Math.round(entry.duration),
			transferSize:
				typeof entry.transferSize === "number" ? entry.transferSize : undefined,
		}));
}

function collectWorkbenchImportResources(limit = 50): StartupResourceTiming[] {
	const importWindowStart = getLatestPerformanceMark(
		"code/willLoadWorkbenchMain",
	);
	const importWindowEnd = getLatestPerformanceMark("code/didLoadWorkbenchMain");
	if (
		typeof importWindowStart !== "number" ||
		typeof importWindowEnd !== "number" ||
		importWindowEnd < importWindowStart
	) {
		return [];
	}

	return performance
		.getEntriesByType("resource")
		.filter(
			(entry): entry is PerformanceResourceTiming =>
				entry instanceof PerformanceResourceTiming,
		)
		.filter(
			(entry) =>
				entry.startTime >= importWindowStart &&
				entry.startTime <= importWindowEnd,
		)
		.filter(
			(entry) =>
				entry.initiatorType === "script" || entry.name.includes("/out/"),
		)
		.sort((left, right) => right.duration - left.duration)
		.slice(0, limit)
		.map((entry) => ({
			name: entry.name,
			initiatorType: entry.initiatorType,
			startTime: Math.round(entry.startTime - importWindowStart),
			duration: Math.round(entry.duration),
			transferSize:
				typeof entry.transferSize === "number" ? entry.transferSize : undefined,
		}));
}

function publishStartupProfile(
	report: StartupProfileReport,
	autoDownload: boolean,
): void {
	(
		window as Window & { __TAURI_STARTUP_PROFILE__?: StartupProfileReport }
	).__TAURI_STARTUP_PROFILE__ = report;
	console.info("[startup.profile]", report);

	if (!autoDownload) {
		return;
	}

	const payload = JSON.stringify(report, null, 2);
	const blob = new Blob([payload], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `tauri-startup-profile-${Date.now()}.json`;
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const SHARED_PROCESS_PATCH_MARKER = "__tauriSharedProcessPatched";

async function installSharedProcessConnectionPatch(
	appRoot: string,
): Promise<void> {
	const candidatePaths = createOutModuleCandidates(
		appRoot,
		"/vs/workbench/services/sharedProcess/electron-browser/sharedProcessService.js",
	);

	for (const modulePath of candidatePaths) {
		try {
			const module = (await import(/* @vite-ignore */ modulePath)) as {
				SharedProcessService?: {
					prototype?: Record<string, unknown>;
				};
			};

			const prototype = module.SharedProcessService?.prototype;
			if (!prototype || prototype[SHARED_PROCESS_PATCH_MARKER] === true) {
				continue;
			}

			const originalConnect = prototype.connect;
			if (typeof originalConnect !== "function") {
				continue;
			}

			prototype.connect = function patchedConnect(
				this: Record<string, unknown>,
				...args: unknown[]
			) {
				this.disableMessagePortTransport = true;
				return (originalConnect as (...innerArgs: unknown[]) => unknown).apply(
					this,
					args,
				);
			};
			prototype[SHARED_PROCESS_PATCH_MARKER] = true;
		} catch (error) {
			console.warn(
				"[tauri.compat] failed to patch shared process connection path",
				{ modulePath, error },
			);
		}
	}
}

function installGlobalStartupErrorHandlers(): void {
	window.addEventListener("error", (event) => {
		if (
			tryRecoverStartupWithLegacy(
				`window.error: ${event.message || "<unknown>"}`,
			)
		) {
			event.preventDefault();
			return;
		}
		const detailParts: string[] = [];
		if (event.error instanceof Error) {
			if (event.error.message) {
				detailParts.push(event.error.message);
			}
			if (event.error.stack) {
				detailParts.push(event.error.stack);
			}
		}
		if (event.message) {
			detailParts.push(String(event.message));
		}
		if (event.filename || event.lineno || event.colno) {
			detailParts.push(
				`at ${event.filename || "<unknown>"}:${event.lineno || 0}:${event.colno || 0}`,
			);
		}
		const message =
			detailParts.length > 0 ? detailParts.join("\n") : "Unknown window error";
		setStatus(`Startup failed:\n${message}`, "error", true);
	});

	window.addEventListener("unhandledrejection", (event) => {
		const reasonDetails = formatErrorDetails(event.reason);
		if (tryRecoverStartupWithLegacy(`unhandledrejection: ${reasonDetails}`)) {
			event.preventDefault();
			return;
		}
		const reason = event.reason;
		const message =
			reason instanceof Error
				? (reason.stack ?? reason.message)
				: String(reason ?? "Unknown rejection");
		setStatus(`Startup failed:\n${message}`, "error", true);
	});
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const parts: string[] = [];
		if (error.name || error.message) {
			parts.push(
				`${error.name || "Error"}: ${error.message || "<no-message>"}`,
			);
		}
		if (error.stack && error.stack.length > 0) {
			parts.push(error.stack);
		}
		return parts.join("\n");
	}

	if (typeof error === "string") {
		return error;
	}

	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

async function installVsCodeUnexpectedErrorHookForPath(
	modulePath: string,
): Promise<void> {
	try {
		const errorsModule = (await import(/* @vite-ignore */ modulePath)) as {
			setUnexpectedErrorHandler?: (handler: (error: unknown) => void) => void;
			errorHandler?: {
				getUnexpectedErrorHandler?: () =>
					| ((error: unknown) => void)
					| undefined;
			};
		};

		if (typeof errorsModule.setUnexpectedErrorHandler !== "function") {
			return;
		}

		const existingHandler =
			errorsModule.errorHandler?.getUnexpectedErrorHandler?.();
		errorsModule.setUnexpectedErrorHandler((error: unknown) => {
			try {
				existingHandler?.(error);
			} catch {
				// If existing handler throws, still prefer surfacing original details.
			}

			const details = formatErrorDetails(error);
			console.error("[vscode unexpected error]", error);
			setStatus(`Startup failed:\n${details}`, "error", true);
		});
	} catch (error) {
		console.warn(
			`[startup] failed to install VS Code unexpected error hook for ${modulePath}`,
			error,
		);
	}
}

async function installVsCodeUnexpectedErrorHooks(
	modulePaths: readonly string[],
): Promise<void> {
	for (const modulePath of [...new Set(modulePaths)]) {
		await installVsCodeUnexpectedErrorHookForPath(modulePath);
	}
}

async function attachDebugHostListeners(host: HostClient): Promise<void> {
	const debugEnabled =
		new URLSearchParams(window.location.search).get("hostDebug") === "1" ||
		(() => {
			try {
				return window.localStorage?.getItem("tauriHostDebug") === "1";
			} catch {
				return false;
			}
		})();
	if (!debugEnabled) {
		return;
	}

	const tryListen = async <E extends HostEventName>(
		eventName: E,
		handler: (payload: HostEventPayload<E>) => void,
	): Promise<void> => {
		try {
			await host.listenEvent(eventName, handler);
		} catch (error) {
			console.warn("[tauri.logs] failed to attach debug listener", {
				eventName,
				error,
			});
		}
	};

	await tryListen("host.lifecycle", (payload) => {
		console.debug("[host.lifecycle]", payload);
	});

	await tryListen("filesystem.changed", (payload) => {
		console.debug("[filesystem.changed]", payload);
	});

	await tryListen("terminal.data", (payload) => {
		console.debug("[terminal.data]", {
			id: payload.id,
			stream: payload.stream,
			bytes: payload.data.length,
		});
	});

	await tryListen("process.exit", (payload) => {
		console.debug("[process.exit]", payload);
	});

	await tryListen("process.data", (payload) => {
		console.debug("[process.data]", {
			pid: payload.pid,
			stream: payload.stream,
			bytes: payload.data.length,
		});
	});

	await tryListen("fallback.used", (payload) => {
		console.debug("[fallback.used]", payload);
	});

	await tryListen("desktop.channelEvent", (payload) => {
		console.debug("[desktop.channelEvent]", payload);
	});
}

const TAURI_DISK_FS_CAPABILITIES_MASK =
	2 | // FileReadWrite
	8 | // FileFolderCopy
	1024 | // PathCaseSensitive
	4096 | // Trash
	131072 | // FileClone
	262144; // FileRealpath

type GlobalWithVscodeFileRoot = typeof globalThis & {
	_VSCODE_FILE_ROOT?: unknown;
	_VSCODE_TAURI_FS_CAPABILITIES_MASK?: unknown;
};

type GlobalWithLocalFontsApi = typeof globalThis & {
	queryLocalFonts?: () => Promise<unknown[]>;
	navigator: Navigator & {
		queryLocalFonts?: () => Promise<unknown[]>;
	};
};

function installLocalFontsCompatibilityPatch(): void {
	const globalWithFonts = globalThis as GlobalWithLocalFontsApi;
	const fallback = async (): Promise<unknown[]> => [];

	if (typeof globalWithFonts.navigator.queryLocalFonts !== "function") {
		globalWithFonts.navigator.queryLocalFonts = fallback;
	}

	if (typeof globalWithFonts.queryLocalFonts !== "function") {
		globalWithFonts.queryLocalFonts = () =>
			globalWithFonts.navigator.queryLocalFonts!();
	}
}

function installFileRootCompatibilityPatch(): void {
	const desiredFileRoot = new URL("/out/", window.location.origin).toString();
	const globalWithFileRoot = globalThis as GlobalWithVscodeFileRoot;
	let currentFileRoot = desiredFileRoot;

	Object.defineProperty(globalWithFileRoot, "_VSCODE_FILE_ROOT", {
		configurable: true,
		enumerable: false,
		get() {
			return currentFileRoot;
		},
		set(nextValue: unknown) {
			if (
				typeof nextValue === "string" &&
				nextValue.startsWith(desiredFileRoot)
			) {
				currentFileRoot = nextValue;
				return;
			}

			currentFileRoot = desiredFileRoot;
		},
	});

	globalWithFileRoot._VSCODE_FILE_ROOT = desiredFileRoot;
	globalWithFileRoot._VSCODE_TAURI_FS_CAPABILITIES_MASK =
		TAURI_DISK_FS_CAPABILITIES_MASK;
}

async function main(): Promise<void> {
	const startupStartTime = performance.now();
	installGlobalStartupErrorHandlers();
	const verboseStartupStatus = shouldShowVerboseStartupStatus();
	const startupProfileEnabled = shouldEnableStartupProfile();
	const autoDownloadStartupProfile = shouldAutoDownloadStartupProfile();
	const stepTimings: StartupStepTiming[] = [];
	const longTaskTimings: StartupLongTaskTiming[] = [];
	let longTaskObserver: PerformanceObserver | undefined;
	if (startupProfileEnabled && typeof PerformanceObserver !== "undefined") {
		try {
			longTaskObserver = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					longTaskTimings.push({
						name: entry.name,
						startTime: Math.round(entry.startTime),
						duration: Math.round(entry.duration),
					});
				}
			});
			longTaskObserver.observe({
				type: "longtask",
				buffered: true,
			} as PerformanceObserverInit);
			console.info("[startup.profile] enabled");
		} catch (error) {
			console.warn(
				"[startup.profile] failed to enable longtask observer",
				error,
			);
		}
	}
	setStatus("Launching Tauri host...");
	const host = new HostClient();
	installHostFetchFallback(host);

	const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
		setStatus(label);
		const stepStart = performance.now();
		try {
			const result = await run();
			const durationMs = Math.round(performance.now() - stepStart);
			stepTimings.push({ label, durationMs });
			if (startupProfileEnabled) {
				console.info(`[startup.step] ${label} ${durationMs}ms`);
			}
			return result;
		} catch (error) {
			const detail = formatErrorDetails(error);
			console.error("[startup.step.error]", { label, error, detail });
			throw new Error(`${label} failed:\n${detail}`);
		}
	};

	const handshake = await step("Handshake with Tauri host...", () =>
		host.handshake(),
	);
	const windowConfig = await step("Resolving window config...", () =>
		host.resolveWindowConfig(),
	);
	const appRoot =
		typeof windowConfig.appRoot === "string" ? windowConfig.appRoot : "";
	console.info("[startup] using appRoot", appRoot);
	const workbenchBootstrapCandidates = resolveWorkbenchBootstrapCandidates(
		appRoot,
		windowConfig,
	);
	console.info(
		"[startup] workbench bootstrap candidates",
		workbenchBootstrapCandidates,
	);
	// Kick modulepreload early so network/parse can overlap with sandbox/compat setup.
	installWorkbenchModulePreloadHints(workbenchBootstrapCandidates);
	const errorModuleCandidates = createOutModuleCandidates(
		appRoot,
		"/vs/base/common/errors.js",
	);

	try {
		await attachDebugHostListeners(host);
	} catch (error) {
		console.warn("[startup] failed to attach debug listeners", error);
	}
	setStatus(
		`Host: ${handshake.serverName} ${handshake.serverVersion} | Protocol ${handshake.protocolVersion}`,
	);

	await step("Installing desktop sandbox...", () =>
		installDesktopSandbox(host),
	);
	installFileRootCompatibilityPatch();
	installLocalFontsCompatibilityPatch();

	setStatus("Loading desktop workbench runtime...");
	const loadedWorkbenchPath = await step(
		"Loading desktop workbench runtime...",
		async () => {
			const candidateFailures: string[] = [];
			for (const candidatePath of workbenchBootstrapCandidates) {
				markBootstrapAttempt(startupBootstrapBuildId, candidatePath);
				try {
					await import(/* @vite-ignore */ candidatePath);
					return candidatePath;
				} catch (error) {
					markBootstrapFailure(startupBootstrapBuildId, candidatePath);
					candidateFailures.push(
						`${candidatePath}: ${formatErrorDetails(error)}`,
					);
					console.warn("[startup] failed to load workbench runtime candidate", {
						candidatePath,
						error,
					});
				}
			}

			const detail = candidateFailures.join("\n\n");
			throw new Error(
				detail.length > 0
					? `Unable to load desktop workbench runtime from any candidate path.\n${detail}`
					: "Unable to load desktop workbench runtime from any candidate path.",
			);
		},
	);
	console.info(
		`[startup] loaded workbench runtime from ${loadedWorkbenchPath}`,
	);

	if (verboseStartupStatus) {
		setStatus("Desktop runtime loaded. Waiting for workbench render...");
	} else {
		setStatus("", "info", false);
	}

	const waitStart = performance.now();
	const rendered = await waitForWorkbenchRender();
	const waitDurationMs = Math.round(performance.now() - waitStart);
	if (rendered) {
		performance.mark("tauri/workbenchFirstRender");
	}
	if (waitDurationMs >= 500) {
		console.info(
			`[startup] waited ${waitDurationMs}ms for first workbench render`,
		);
		logStartupBreakdown(waitDurationMs);
	}

	if (rendered) {
		markBootstrapSuccess(startupBootstrapBuildId, loadedWorkbenchPath);
		startupPhaseActive = false;
		setStatus("", "info", false);
		const runDeferredStartupPatches = () => {
			void installSharedProcessConnectionPatch(appRoot).catch((error) => {
				console.warn(
					"[tauri.compat] shared-process compatibility patch failed",
					error,
				);
			});

			void installVsCodeUnexpectedErrorHooks(errorModuleCandidates).catch(
				(error) => {
					console.warn(
						"[tauri.compat] failed to install VS Code unexpected error hooks",
						error,
					);
				},
			);
		};

		if (typeof window.requestIdleCallback === "function") {
			window.requestIdleCallback(() => runDeferredStartupPatches(), {
				timeout: 2000,
			});
		} else {
			window.setTimeout(runDeferredStartupPatches, 0);
		}

		if (startupProfileEnabled) {
			let fallbackCounts: Record<string, number> | undefined;
			try {
				fallbackCounts = await host.getFallbackCounts();
			} catch (error) {
				console.warn("[startup.profile] failed to read fallback counts", error);
			}

			publishStartupProfile(
				{
					totalStartupMs: Math.round(performance.now() - startupStartTime),
					firstRenderWaitMs: waitDurationMs,
					loadedWorkbenchPath,
					phases: getStartupPhaseDurations(),
					steps: stepTimings,
					longTasks: longTaskTimings.sort(
						(left, right) => right.duration - left.duration,
					),
					topResources: collectTopStartupResources(),
					workbenchImportResources: collectWorkbenchImportResources(),
					fallbackCounts,
				},
				autoDownloadStartupProfile,
			);
		}

		longTaskObserver?.disconnect();

		return;
	}

	longTaskObserver?.disconnect();

	setStatus(
		"Workbench did not render within 15s.\n" +
			"Run with ?hostDebug=1 and share console errors.",
		"error",
		true,
	);
}

main().catch((error) => {
	if (tryRecoverStartupWithLegacy(`main.catch: ${formatErrorDetails(error)}`)) {
		return;
	}
	startupPhaseActive = false;

	const message =
		error instanceof Error
			? error.message || error.stack || String(error)
			: String(error);
	setStatus(`Startup failed:\n${message}`, "error", true);
	console.error(error);
});
