import joplin from 'api';
import { ContentScriptType, MenuItemLocation, SettingItemType, ToolbarButtonLocation } from 'api/types';

const SECTION_NAME = 'admonitionWorkflow';
const CUSTOM_STATUS_TOKEN_KEY = 'customStatusToken';

const COMMAND_TOGGLE_DONE = 'admonition.toggleDone';
const COMMAND_MARK_PENDING = 'admonition.markPending';
const COMMAND_TOGGLE_SUCCESS = 'admonition.toggleSuccess';
const COMMAND_TOGGLE_CUSTOM = 'admonition.toggleCustom';
const COMMAND_TOGGLE_STRIKETHROUGH = 'admonition.toggleStrikethrough';
const COMMAND_INSERT_TYPE_PREFIX = 'admonition.insertType.';
const COMMAND_INSERT_DAILY_TEMPLATE = 'admonition.insertDailyTemplate';
const COMMAND_TOGGLE_DASHBOARD = 'admonition.toggleDashboard';

const DASHBOARD_PANEL_ID = 'admonitionWorkflowDashboardPanel';

const ADMONITION_TYPES = [
	'note',
	'abstract',
	'info',
	'tip',
	'success',
	'question',
	'warning',
	'failure',
	'danger',
	'bug',
	'example',
	'quote',
];

const ADMONITION_TYPE_LABELS: Record<string, string> = {
	note: '备注',
	abstract: '摘要',
	info: '信息',
	tip: '技巧',
	success: '成功',
	question: '问题',
	warning: '警告',
	failure: '失败',
	danger: '危险',
	bug: '故障',
	example: '示例',
	quote: '引用',
};

const DEFAULT_CUSTOM_STATUS_TOKEN = '⭐';

let dashboardPanelHandle: string | null = null;

type DashboardLaneKey = 'pending' | 'completed' | 'success';

interface DashboardState {
	noteTitle: string;
	noteDate: string;
	pendingCount: number;
	completedCount: number;
	successCount: number;
	customCount: number;
	strikethroughCount: number;
	admonitionCount: number;
	lanes: Record<DashboardLaneKey, string[]>;
}

function splitLines(text: string): string[] {
	return text.split('\n');
}

function mapLines(text: string, lineMapper: (line: string) => string): string {
	return splitLines(text).map(lineMapper).join('\n');
}

function leadingWhitespace(input: string): string {
	const match = input.match(/^\s*/);
	return match ? match[0] : '';
}

function trailingWhitespace(input: string): string {
	const match = input.match(/\s*$/);
	return match ? match[0] : '';
}

function escapeForRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleCase(input: string): string {
	if (!input) return input;
	return input.charAt(0).toUpperCase() + input.slice(1);
}

function localizedAdmonitionTypeLabel(type: string): string {
	return ADMONITION_TYPE_LABELS[type] || titleCase(type);
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function stripKnownStatePrefix(input: string): string {
	let output = input;
	let changed = true;

	while (changed) {
		changed = false;
		const before = output;
		output = output.replace(/^\[(?: |x|X)\]\s*/, '');
		output = output.replace(/^✅\s*/, '');
		if (output !== before) {
			output = output.replace(/^\s+/, '');
			changed = true;
		}
	}

	return output;
}

function splitListMarker(input: string): { marker: string | null; content: string } {
	const listPrefix = input.match(/^([-*+]|\d+\.)\s+(.*)$/);
	if (!listPrefix) return { marker: null, content: input };
	return { marker: listPrefix[1], content: listPrefix[2] };
}

function normalizeStateLine(line: string): { indent: string; marker: string | null; content: string } {
	const indent = leadingWhitespace(line);
	let body = line.slice(indent.length);

	// Compatibility path: old versions could prepend ✅ before list marker.
	body = stripKnownStatePrefix(body);

	const parsed = splitListMarker(body);
	const marker = parsed.marker;
	const content = stripKnownStatePrefix(parsed.content).trimStart();

	return { indent, marker, content };
}

function buildStateLine(line: string, target: 'pending' | 'completed' | 'success'): string {
	if (!line.trim()) return line;

	const normalized = normalizeStateLine(line);
	const suffix = normalized.content ? ` ${normalized.content}` : '';

	if (target === 'success') {
		return `${normalized.indent}✅${suffix}`;
	}

	const checkbox = target === 'completed' ? '[x]' : '[ ]';
	const marker = normalized.marker || '-';
	return `${normalized.indent}${marker} ${checkbox}${suffix}`;
}

function toggleDoneLine(line: string): string {
	return buildStateLine(line, 'completed');
}

function markPendingLine(line: string): string {
	return buildStateLine(line, 'pending');
}

function markSuccessLine(line: string): string {
	return buildStateLine(line, 'success');
}

function normalizeToken(input: string): string {
	const token = (input || '').trim();
	return token || DEFAULT_CUSTOM_STATUS_TOKEN;
}

function stripListMarker(input: string): string {
	return input.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
}

function stripCustomToken(input: string, token: string): string {
	const customToken = normalizeToken(token);
	return input.replace(new RegExp(`^${escapeForRegex(customToken)}\\s*`), '');
}

function stripDisplayPrefixes(input: string, customToken: string): string {
	let output = stripListMarker(input).trimStart();
	output = stripKnownStatePrefix(output);
	output = stripCustomToken(output, customToken).trimStart();
	if (output.startsWith('~~') && output.endsWith('~~') && output.length >= 4) {
		output = output.slice(2, -2);
	}
	return output.trim();
}

function lineHasCustomToken(input: string, token: string): boolean {
	const customToken = normalizeToken(token);
	const normalized = stripListMarker(input).trimStart();
	return new RegExp(`^${escapeForRegex(customToken)}(?:\\s|$)`).test(normalized);
}

function buildDashboardState(noteTitle: string, body: string, customToken: string): DashboardState {
	const normalizedToken = normalizeToken(customToken);
	const state: DashboardState = {
		noteTitle: noteTitle || 'Untitled note',
		noteDate: formatDateLabel(new Date()),
		pendingCount: 0,
		completedCount: 0,
		successCount: 0,
		customCount: 0,
		strikethroughCount: 0,
		admonitionCount: 0,
		lanes: {
			pending: [],
			completed: [],
			success: [],
		},
	};

	for (const rawLine of splitLines(body || '')) {
		const line = rawLine.trim();
		if (!line) continue;

		if (/^!!!\s+[a-z]+(?:\s|$)/i.test(line)) {
			state.admonitionCount += 1;
		}

		if (/^\s*(?:[-*+]|\d+\.)\s+\[ \]\s+/i.test(rawLine)) {
			state.pendingCount += 1;
			if (state.lanes.pending.length < 5) {
				state.lanes.pending.push(stripDisplayPrefixes(rawLine, normalizedToken));
			}
			continue;
		}

		if (/^\s*(?:[-*+]|\d+\.)\s+\[(?:x|X)\]\s+/i.test(rawLine)) {
			state.completedCount += 1;
			if (state.lanes.completed.length < 5) {
				state.lanes.completed.push(stripDisplayPrefixes(rawLine, normalizedToken));
			}
			continue;
		}

		if (/^\s*(?:(?:[-*+]|\d+\.)\s+)?✅(?:\s|$)/.test(rawLine)) {
			state.successCount += 1;
			if (state.lanes.success.length < 5) {
				state.lanes.success.push(stripDisplayPrefixes(rawLine, normalizedToken));
			}
			continue;
		}

		if (lineHasCustomToken(rawLine, normalizedToken)) {
			state.customCount += 1;
		}

		if (/^\s*(?:(?:[-*+]|\d+\.)\s+)?~~.*~~\s*$/.test(rawLine)) {
			state.strikethroughCount += 1;
		}
	}

	return state;
}

function renderDashboardList(items: string[], emptyLabel: string): string {
	if (!items.length) {
		return `<div class="empty">${escapeHtml(emptyLabel)}</div>`;
	}

	return `<ul class="lane-list">${items
		.map((item) => `<li>${escapeHtml(item || 'Untitled item')}</li>`)
		.join('')}</ul>`;
}

function toggleLinePrefix(line: string, token: string): string {
	if (!line.trim()) return line;

	const indent = leadingWhitespace(line);
	const content = line.slice(indent.length);
	const prefixRegex = new RegExp(`^${escapeForRegex(token)}\\s*`);

	if (prefixRegex.test(content)) {
		return `${indent}${content.replace(prefixRegex, '')}`;
	}

	return `${indent}${token} ${content}`.replace(/\s+$/, '');
}

function toggleLineStrikethrough(line: string): string {
	if (!line.trim()) return line;

	const indent = leadingWhitespace(line);
	const contentWithTrailing = line.slice(indent.length);
	const trailing = trailingWhitespace(contentWithTrailing);
	const content = contentWithTrailing.slice(0, contentWithTrailing.length - trailing.length);

	if (!content) return line;

	if (content.startsWith('~~') && content.endsWith('~~') && content.length >= 4) {
		return `${indent}${content.slice(2, -2)}${trailing}`;
	}

	return `${indent}~~${content}~~${trailing}`;
}

async function selectedText(): Promise<string> {
	const value = await joplin.commands.execute('selectedText');
	return typeof value === 'string' ? value : '';
}

async function transformSelection(transformer: (text: string) => string): Promise<boolean> {
	try {
		const current = await selectedText();
		if (!current) return false;

		const next = transformer(current);
		if (next !== current) {
			await joplin.commands.execute('replaceSelection', next);
		}

		return true;
	} catch (error) {
		return false;
	}
}

async function replaceSelectionSafely(text: string): Promise<boolean> {
	try {
		await joplin.commands.execute('replaceSelection', text);
		return true;
	} catch (error) {
		return false;
	}
}

async function markSelectionCompleted(): Promise<boolean> {
	return transformSelection((text) => mapLines(text, toggleDoneLine));
}

async function markSelectionPending(): Promise<boolean> {
	return transformSelection((text) => mapLines(text, markPendingLine));
}

async function markSelectionSuccess(): Promise<boolean> {
	return transformSelection((text) => mapLines(text, markSuccessLine));
}

async function toggleSelectionCustom(): Promise<boolean> {
	const configured = await joplin.settings.value(CUSTOM_STATUS_TOKEN_KEY) as string;
	const token = normalizeToken(configured);
	return transformSelection((text) => mapLines(text, (line) => toggleLinePrefix(line, token)));
}

async function toggleSelectionStrikethrough(): Promise<boolean> {
	const changed = await transformSelection((text) => mapLines(text, toggleLineStrikethrough));
	if (changed) return true;

	try {
		await joplin.commands.execute('textStrikethrough');
		return true;
	} catch (error) {
		return false;
	}
}

function buildAdmonitionBlock(type: string, current: string): string {
	const title = localizedAdmonitionTypeLabel(type);
	const body = current && current.trim().length ? current : 'Write details here';
	return `!!! ${type} ${title}\n${body}\n!!!`;
}

async function insertAdmonitionBlock(type: string): Promise<boolean> {
	let current = '';
	try {
		current = await selectedText();
	} catch (error) {
		current = '';
	}

	return replaceSelectionSafely(buildAdmonitionBlock(type, current));
}

function formatDateLabel(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function buildDailyTemplate(): string {
	const today = formatDateLabel(new Date());
	return [
		`!!! note [+] Daily Worklog ${today}`,
		'- [ ] Pending: ',
		'- [x] Completed: ',
		'- ✅ Success: ',
		'!!!',
	].join('\n');
}

async function insertDailyTemplate(): Promise<boolean> {
	return replaceSelectionSafely(buildDailyTemplate());
}

async function appendTextToCurrentNote(text: string): Promise<boolean> {
	const note = await joplin.workspace.selectedNote();
	if (!note?.id) return false;

	const currentBody = note.body || '';
	const separator = currentBody.trim().length ? (currentBody.endsWith('\n') ? '\n' : '\n\n') : '';
	await joplin.data.put(['notes', note.id], null, {
		body: `${currentBody}${separator}${text}`,
	});
	return true;
}

function dashboardHtml(state: DashboardState): string {
	const typeButtons = ADMONITION_TYPES
		.map((type) => `<button class="chip" data-kind="type" data-value="${type}">${localizedAdmonitionTypeLabel(type)}</button>`)
		.join('');

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<style>
		:root {
			color-scheme: dark light;
			--bg0: #0c1222;
			--bg1: #151f37;
			--card: rgba(255, 255, 255, 0.08);
			--line: rgba(255, 255, 255, 0.18);
			--text: #f4f8ff;
			--muted: #b8c5dd;
			--accentA: #2ad4ff;
			--accentB: #62f0a8;
			--accentC: #ffb347;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
			background:
				radial-gradient(1200px 420px at -100px -120px, #2546a544, transparent 60%),
				radial-gradient(920px 380px at 120% -50px, #18a3993d, transparent 55%),
				linear-gradient(165deg, var(--bg0), var(--bg1));
			color: var(--text);
			min-height: 100vh;
			padding: 14px;
		}
		.wrap {
			display: grid;
			grid-template-columns: 1fr;
			gap: 12px;
		}
		.hero {
			border: 1px solid var(--line);
			border-radius: 14px;
			background: linear-gradient(140deg, #193058ad, #0b1b2fad);
			padding: 14px;
			box-shadow: 0 12px 30px #00000040;
		}
		.title {
			margin: 0;
			font-size: 15px;
			letter-spacing: 0.2px;
			font-weight: 700;
		}
		.subtitle {
			margin: 6px 0 0;
			color: var(--muted);
			font-size: 12px;
		}
		.grid {
			display: grid;
			grid-template-columns: 1fr;
			gap: 10px;
		}
		.card {
			border: 1px solid var(--line);
			border-radius: 12px;
			background: var(--card);
			backdrop-filter: blur(4px);
			padding: 12px;
		}
		.card h3 {
			margin: 0 0 8px;
			font-size: 13px;
			font-weight: 700;
			color: #ecf4ff;
		}
		.hero-meta {
			margin-top: 10px;
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
		}
		.hero-chip {
			border: 1px solid #ffffff22;
			border-radius: 999px;
			padding: 4px 8px;
			font-size: 11px;
			color: #d8e7ff;
			background: #ffffff12;
		}
		.row {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
		}
		.stat-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 8px;
		}
		.stat-box {
			border: 1px solid #ffffff1c;
			border-radius: 12px;
			padding: 10px;
			background: #ffffff0a;
		}
		.stat-box strong {
			display: block;
			font-size: 18px;
			line-height: 1.1;
		}
		.stat-box span {
			display: block;
			margin-top: 4px;
			color: #c6d2ea;
			font-size: 11px;
		}
		button {
			border: 0;
			cursor: pointer;
			border-radius: 10px;
			padding: 8px 10px;
			font-size: 12px;
			font-weight: 700;
			transition: transform .12s ease, filter .18s ease;
		}
		button:active { transform: scale(0.98); }
		.status.pending { background: #ffd166; color: #2f2500; }
		.status.completed { background: #9be564; color: #112900; }
		.status.success { background: #65f5d3; color: #003025; }
		.status.custom { background: #9ab6ff; color: #081f57; }
		.status.strike { background: #d7a7ff; color: #2b0448; }
		.template { background: linear-gradient(135deg, var(--accentA), var(--accentB)); color: #002935; }
		.chip {
			background: #ffffff14;
			color: #eaf0ff;
			border: 1px solid #ffffff26;
			font-weight: 600;
			padding: 7px 9px;
		}
		.chip:hover { filter: brightness(1.15); }
		.board {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 8px;
		}
		.lane {
			border: 1px solid #ffffff18;
			border-radius: 12px;
			padding: 10px;
			background: #ffffff08;
			min-height: 168px;
		}
		.lane h4 {
			margin: 0 0 8px;
			font-size: 12px;
			font-weight: 700;
		}
		.lane.pending h4 { color: #ffe08a; }
		.lane.completed h4 { color: #c7ff92; }
		.lane.success h4 { color: #97ffe5; }
		.lane-list {
			margin: 0;
			padding-left: 16px;
			display: grid;
			gap: 6px;
			font-size: 12px;
			color: #e9f1ff;
		}
		.empty {
			font-size: 12px;
			color: #9fb1d4;
			padding-top: 4px;
		}
		.status-line {
			border-top: 1px dashed #ffffff2a;
			padding-top: 9px;
			color: #daf8ff;
			font-size: 12px;
			min-height: 18px;
		}
		.status-line.error { color: #ffd3d3; }
	</style>
</head>
<body>
	<div class="wrap">
		<section class="hero">
			<h1 class="title">Admonition 指挥台</h1>
			<p class="subtitle">在侧边栏快速维护工作日志，像控制台一样切换状态与结构。</p>
			<div class="hero-meta">
				<span class="hero-chip">${escapeHtml(state.noteTitle)}</span>
				<span class="hero-chip">Updated ${escapeHtml(state.noteDate)}</span>
				<span class="hero-chip">${state.admonitionCount} admonitions</span>
			</div>
		</section>

		<div class="grid">
			<section class="card">
				<h3>笔记概览</h3>
				<div class="stat-grid">
					<div class="stat-box"><strong>${state.pendingCount}</strong><span>待完成</span></div>
					<div class="stat-box"><strong>${state.completedCount}</strong><span>已完成</span></div>
					<div class="stat-box"><strong>${state.successCount}</strong><span>成功</span></div>
					<div class="stat-box"><strong>${state.customCount}</strong><span>自定义状态</span></div>
					<div class="stat-box"><strong>${state.strikethroughCount}</strong><span>删除线条目</span></div>
					<div class="stat-box"><strong>${state.admonitionCount}</strong><span>Admonition 块</span></div>
				</div>
			</section>

			<section class="card">
				<h3>状态快切</h3>
				<div class="row">
					<button class="status pending" data-kind="status" data-value="pending">待完成</button>
					<button class="status completed" data-kind="status" data-value="completed">已完成</button>
					<button class="status success" data-kind="status" data-value="success">成功</button>
					<button class="status custom" data-kind="status" data-value="custom">自定义状态</button>
					<button class="status strike" data-kind="format" data-value="strike">删除线</button>
				</div>
			</section>

			<section class="card">
				<h3>结构模板</h3>
				<div class="row">
					<button class="template" data-kind="template" data-value="daily">插入 Worklog 模板</button>
				</div>
			</section>

			<section class="card">
				<h3>Admonition 类型</h3>
				<div class="row">${typeButtons}</div>
			</section>

			<section class="card">
				<h3>状态看板预览</h3>
				<div class="board">
					<div class="lane pending">
						<h4>待完成</h4>
						${renderDashboardList(state.lanes.pending, '当前没有待完成条目')}
					</div>
					<div class="lane completed">
						<h4>已完成</h4>
						${renderDashboardList(state.lanes.completed, '当前没有已完成条目')}
					</div>
					<div class="lane success">
						<h4>成功</h4>
						${renderDashboardList(state.lanes.success, '当前没有成功条目')}
					</div>
				</div>
			</section>
		</div>

		<div class="status-line" id="statusLine">指挥台已就绪</div>
	</div>
</body>
</html>`;
}

async function refreshDashboardPanel(): Promise<void> {
	if (!dashboardPanelHandle) return;

	const note = await joplin.workspace.selectedNote();
	const configured = await joplin.settings.value(CUSTOM_STATUS_TOKEN_KEY) as string;
	const dashboardState = buildDashboardState(
		note?.title || 'Untitled note',
		note?.body || '',
		configured,
	);

	await joplin.views.panels.setHtml(dashboardPanelHandle, dashboardHtml(dashboardState));
	await joplin.views.panels.addScript(dashboardPanelHandle, './dashboardPanel.js');
}

async function handleDashboardMessage(message: any): Promise<{ ok: boolean; message?: string; error?: string }> {
	if (!message || typeof message !== 'object') {
		return { ok: false, error: 'Invalid action payload.' };
	}

	try {
		if (message.kind === 'status') {
			if (message.value === 'pending') {
				const changed = await markSelectionPending();
				if (!changed) return { ok: false, error: '请先在编辑器中选中要处理的文本。' };
				return { ok: true, message: '已切换到待完成' };
			}
			if (message.value === 'completed') {
				const changed = await markSelectionCompleted();
				if (!changed) return { ok: false, error: '请先在编辑器中选中要处理的文本。' };
				return { ok: true, message: '已切换到已完成' };
			}
			if (message.value === 'success') {
				const changed = await markSelectionSuccess();
				if (!changed) return { ok: false, error: '请先在编辑器中选中要处理的文本。' };
				return { ok: true, message: '已切换到成功' };
			}
			if (message.value === 'custom') {
				const changed = await toggleSelectionCustom();
				if (!changed) return { ok: false, error: '请先在编辑器中选中要处理的文本。' };
				return { ok: true, message: '已切换自定义状态' };
			}
		}

		if (message.kind === 'format' && message.value === 'strike') {
			const changed = await toggleSelectionStrikethrough();
			if (!changed) return { ok: false, error: '请先在编辑器中选中要处理的文本。' };
			return { ok: true, message: '已应用删除线切换' };
		}

		if (message.kind === 'template' && message.value === 'daily') {
			const inserted = await insertDailyTemplate();
			if (inserted) {
				return { ok: true, message: '已插入日报模板' };
			}

			const appended = await appendTextToCurrentNote(buildDailyTemplate());
			if (appended) {
				return { ok: true, message: '编辑器未聚焦，已追加到当前笔记末尾' };
			}

			return { ok: false, error: '无法插入模板，请先切回 Markdown 编辑器。' };
		}

		if (message.kind === 'type' && typeof message.value === 'string' && ADMONITION_TYPES.includes(message.value)) {
			const inserted = await insertAdmonitionBlock(message.value);
			if (inserted) {
				return { ok: true, message: `已插入${localizedAdmonitionTypeLabel(message.value)}块` };
			}

			const appended = await appendTextToCurrentNote(buildAdmonitionBlock(message.value, ''));
			if (appended) {
				return { ok: true, message: `编辑器未聚焦，已在笔记末尾追加${localizedAdmonitionTypeLabel(message.value)}块` };
			}

			return { ok: false, error: '无法插入提示块，请先切回 Markdown 编辑器。' };
		}

		return { ok: false, error: 'Unsupported action.' };
	} catch (error) {
		const detail = error instanceof Error ? error.message : 'Unknown error';
		return { ok: false, error: `Action failed: ${detail}` };
	}
}

async function ensureDashboardPanel(): Promise<string> {
	if (dashboardPanelHandle) return dashboardPanelHandle;

	dashboardPanelHandle = await joplin.views.panels.create(DASHBOARD_PANEL_ID);
	await joplin.views.panels.onMessage(dashboardPanelHandle, async (message: any) => {
		return handleDashboardMessage(message);
	});
	await refreshDashboardPanel();

	return dashboardPanelHandle;
}

async function registerSettings() {
	await joplin.settings.registerSection(SECTION_NAME, {
		label: 'Admonition Workflow',
		iconName: 'fas fa-tasks',
	});

	await joplin.settings.registerSettings({
		[CUSTOM_STATUS_TOKEN_KEY]: {
			value: DEFAULT_CUSTOM_STATUS_TOKEN,
			type: SettingItemType.String,
			section: SECTION_NAME,
			public: true,
			label: 'Custom status token',
			description: 'Token used by the right-click "Toggle Custom Status" command (for example: 🚧, [Blocked], [Review]).',
		},
	});
}

async function registerCommands() {
	await joplin.commands.register({
		name: COMMAND_TOGGLE_DONE,
		label: '标记为已完成',
		execute: async () => {
			await markSelectionCompleted();
		},
	});

	await joplin.commands.register({
		name: COMMAND_MARK_PENDING,
		label: '标记为待完成',
		execute: async () => {
			await markSelectionPending();
		},
	});

	await joplin.commands.register({
		name: COMMAND_TOGGLE_SUCCESS,
		label: '标记为成功',
		execute: async () => {
			await markSelectionSuccess();
		},
	});

	await joplin.commands.register({
		name: COMMAND_TOGGLE_CUSTOM,
		label: '切换自定义状态',
		execute: async () => {
			await toggleSelectionCustom();
		},
	});

	await joplin.commands.register({
		name: COMMAND_TOGGLE_STRIKETHROUGH,
		label: '切换删除线',
		execute: async () => {
			await toggleSelectionStrikethrough();
		},
	});

	await joplin.commands.register({
		name: COMMAND_INSERT_DAILY_TEMPLATE,
		label: '插入工作日志模板',
		execute: async () => {
			return insertDailyTemplate();
		},
	});

	for (const type of ADMONITION_TYPES) {
		await joplin.commands.register({
			name: `${COMMAND_INSERT_TYPE_PREFIX}${type}`,
			label: `插入${localizedAdmonitionTypeLabel(type)}块（${type}）`,
			execute: async () => {
				return insertAdmonitionBlock(type);
			},
		});
	}
}

async function registerDashboardFeatures() {
	await joplin.commands.register({
		name: COMMAND_TOGGLE_DASHBOARD,
		label: '切换 Admonition 指挥台',
		execute: async () => {
			const handle = await ensureDashboardPanel();
			const visible = await joplin.views.panels.visible(handle);
			if (!visible) {
				await refreshDashboardPanel();
			}
			await joplin.views.panels.show(handle, !visible);
		},
	});

	await joplin.views.toolbarButtons.create(
		'admonitionCommandCenterToolbarButton',
		COMMAND_TOGGLE_DASHBOARD,
		ToolbarButtonLocation.EditorToolbar,
	);

	await joplin.views.menuItems.create(
		'admonitionCommandCenterToolsMenu',
		COMMAND_TOGGLE_DASHBOARD,
		MenuItemLocation.Tools,
	);

	const handle = await ensureDashboardPanel();
	await joplin.views.panels.hide(handle);

	await joplin.workspace.onNoteSelectionChange(async () => {
		await refreshDashboardPanel();
	});

	await joplin.workspace.onNoteChange(async () => {
		await refreshDashboardPanel();
	});

	await joplin.settings.onChange(async () => {
		await refreshDashboardPanel();
	});
}

async function registerContextMenuItems() {
	await joplin.views.menuItems.create('admonitionToggleDoneMenuItem', COMMAND_TOGGLE_DONE, MenuItemLocation.EditorContextMenu);
	await joplin.views.menuItems.create('admonitionMarkPendingMenuItem', COMMAND_MARK_PENDING, MenuItemLocation.EditorContextMenu);
	await joplin.views.menuItems.create('admonitionToggleSuccessMenuItem', COMMAND_TOGGLE_SUCCESS, MenuItemLocation.EditorContextMenu);
	await joplin.views.menuItems.create('admonitionToggleCustomMenuItem', COMMAND_TOGGLE_CUSTOM, MenuItemLocation.EditorContextMenu);
	await joplin.views.menuItems.create('admonitionToggleStrikeMenuItem', COMMAND_TOGGLE_STRIKETHROUGH, MenuItemLocation.EditorContextMenu);
	for (const type of ADMONITION_TYPES) {
		await joplin.views.menuItems.create(`admonitionInsert${titleCase(type)}MenuItem`, `${COMMAND_INSERT_TYPE_PREFIX}${type}`, MenuItemLocation.EditorContextMenu);
	}
}


joplin.plugins.register({
	onStart: async function() {
		// Here we register new Markdown plugin
		await joplin.contentScripts.register(
			ContentScriptType.MarkdownItPlugin,
			'admonition',
			'./markdownItAdmonition.js'
		);

		await registerSettings();
		await registerCommands();
		await registerContextMenuItems();
		await registerDashboardFeatures();
	},
});
