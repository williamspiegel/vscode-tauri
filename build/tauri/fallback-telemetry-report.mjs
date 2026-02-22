/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function metricsPathFromEnvOrDefault() {
	if (process.env.VSCODE_TAURI_FALLBACK_METRICS_PATH) {
		return path.resolve(process.env.VSCODE_TAURI_FALLBACK_METRICS_PATH);
	}

	return path.join(repoRoot, 'apps/tauri/logs/fallback-metrics.json');
}

function eventsPathFromEnvOrDefault(metricsPath) {
	if (process.env.VSCODE_TAURI_FALLBACK_EVENTS_PATH) {
		return path.resolve(process.env.VSCODE_TAURI_FALLBACK_EVENTS_PATH);
	}

	const ext = path.extname(metricsPath);
	if (ext.length === 0) {
		return `${metricsPath}.events.jsonl`;
	}

	return `${metricsPath.slice(0, -ext.length)}.events.jsonl`;
}

function readMetrics(metricsPath) {
	if (!fs.existsSync(metricsPath)) {
		return null;
	}

	return JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
}

function readEvents(eventsPath) {
	if (!fs.existsSync(eventsPath)) {
		return [];
	}

	const lines = fs
		.readFileSync(eventsPath, 'utf8')
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean);

	const events = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (typeof parsed?.at_ms === 'number' && typeof parsed?.method === 'string') {
				events.push(parsed);
			}
		} catch {
			// Ignore malformed lines to keep reporting resilient.
		}
	}

	return events;
}

const metricsPath = metricsPathFromEnvOrDefault();
const eventsPath = eventsPathFromEnvOrDefault(metricsPath);
const reportPath = path.join(repoRoot, 'tauri-fallback-telemetry.md');

const metrics = readMetrics(metricsPath);
const events = readEvents(eventsPath);

const lines = [
	'# Tauri Fallback Telemetry',
	'',
	`Generated: ${new Date().toISOString()}`,
	`Metrics path: ${path.relative(repoRoot, metricsPath)}`,
	`Events path: ${path.relative(repoRoot, eventsPath)}`,
	''
];

if (!metrics || typeof metrics !== 'object' || typeof metrics.counts !== 'object') {
	lines.push('No persisted fallback metrics found yet.');
	fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
	console.log(`Wrote ${path.relative(repoRoot, reportPath)}`);
	process.exit(0);
}

const counts = Object.entries(metrics.counts)
	.filter(([, value]) => typeof value === 'number')
	.map(([method, count]) => ({ method, count }))
	.sort((a, b) => b.count - a.count || a.method.localeCompare(b.method));

const totalInvocations = counts.reduce((total, entry) => total + entry.count, 0);
const now = Date.now();
const oneDayAgo = now - 24 * 60 * 60 * 1000;
const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

const last24h = events.filter(event => event.at_ms >= oneDayAgo).length;
const last7d = events.filter(event => event.at_ms >= sevenDaysAgo).length;

lines.push(`Total fallback invocations (lifetime): ${totalInvocations}`);
lines.push(`Events observed in last 24h: ${last24h}`);
lines.push(`Events observed in last 7d: ${last7d}`);
lines.push('');
lines.push('## Top Fallback Methods');
lines.push('');
if (counts.length === 0) {
	lines.push('No fallback methods recorded.');
} else {
	lines.push('| Method | Count |');
	lines.push('| --- | ---: |');
	for (const entry of counts.slice(0, 20)) {
		lines.push(`| ${entry.method} | ${entry.count} |`);
	}
}

const dailyTotals = new Map();
for (const event of events) {
	if (event.at_ms < sevenDaysAgo) {
		continue;
	}

	const day = new Date(event.at_ms).toISOString().slice(0, 10);
	dailyTotals.set(day, (dailyTotals.get(day) ?? 0) + 1);
}

lines.push('');
lines.push('## Daily Events (Last 7 Days)');
lines.push('');
if (dailyTotals.size === 0) {
	lines.push('No fallback events observed in the last 7 days.');
} else {
	lines.push('| Date (UTC) | Event Count |');
	lines.push('| --- | ---: |');
	for (const day of Array.from(dailyTotals.keys()).sort()) {
		lines.push(`| ${day} | ${dailyTotals.get(day)} |`);
	}
}

fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
console.log(`Wrote ${path.relative(repoRoot, reportPath)}`);
