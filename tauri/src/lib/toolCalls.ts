export type ToolFamily =
	| "analysis"
	| "debugger"
	| "filesystem"
	| "shell"
	| "memory"
	| "console"
	| "generic";

export type ToolRisk = "observe" | "mutate" | "execute" | "unknown";

export interface ToolArgumentField {
	key: string;
	label: string;
	value: string;
	mono?: boolean;
}

export interface ToolCallView {
	name: string;
	family: ToolFamily;
	familyLabel: string;
	operation: string;
	operationLabel: string;
	risk: ToolRisk;
	riskLabel: string;
	targetLabel: string;
	target?: string;
	summary: string;
	fields: ToolArgumentField[];
	command?: string;
}

export interface ToolResultFact {
	label: string;
	value: string;
	tone?: "default" | "warning" | "danger";
}

const ANALYSIS_LABELS: Record<string, string> = {
	analyze: "Index target",
	functions: "Function inventory",
	disasm: "Disassemble",
	graph: "Control-flow graph",
	lift: "Lift to IR",
	decompile: "Decompile",
	xrefs: "Cross-references",
	strings: "String sweep",
	imports: "Import table",
	info: "Target fingerprint",
	raw: "Backend console",
};

const ANALYSIS_SUMMARIES: Record<string, string> = {
	analyze: "Build the active analysis index",
	functions: "Enumerate recovered functions",
	disasm: "Decode instructions around a target",
	graph: "Recover basic blocks and edges",
	lift: "Raise a function into IR",
	decompile: "Recover higher-level control flow",
	xrefs: "Trace references to a target",
	strings: "Search embedded string data",
	imports: "Inspect external symbol references",
	info: "Collect target metadata and layout",
	raw: "Run a backend-native analysis command",
};

const DEBUG_LABELS: Record<string, string> = {
	launch: "Launch target",
	attach: "Attach process",
	continue: "Continue target",
	step: "Step execution",
	interrupt: "Interrupt target",
	break: "Set breakpoint",
	unbreak: "Remove breakpoint",
	breakpoints: "Breakpoint table",
	regs: "Register snapshot",
	setreg: "Write register",
	read: "Read process memory",
	write: "Write process memory",
	backtrace: "Call stack",
	threads: "Thread state",
	disasm: "Runtime disassembly",
	stdin: "Write stdin",
	output: "Capture output",
	status: "Debugger status",
	detach: "Detach target",
	kill: "Kill target",
};

const DEBUG_SUMMARIES: Record<string, string> = {
	launch: "Start a child under the debugger",
	attach: "Attach to a running process",
	continue: "Resume the debugged process",
	step: "Advance one instruction or call",
	interrupt: "Pause the debugged process",
	break: "Place a runtime breakpoint",
	unbreak: "Remove a runtime breakpoint",
	breakpoints: "Inspect active breakpoints",
	regs: "Read the live register state",
	setreg: "Change a live register value",
	read: "Read bytes from process memory",
	write: "Patch bytes in process memory",
	backtrace: "Inspect the live call stack",
	threads: "Inspect thread state",
	disasm: "Decode mapped runtime instructions",
	stdin: "Send data to the debuggee",
	output: "Read captured target output",
	status: "Check debugger lifecycle state",
	detach: "Leave the target running",
	kill: "Terminate the debugged target",
};

const DEBUG_OBSERVE = new Set([
	"breakpoints",
	"regs",
	"read",
	"backtrace",
	"threads",
	"disasm",
	"output",
	"status",
]);

const DEBUG_EXECUTE = new Set([
	"launch",
	"attach",
	"continue",
	"step",
	"interrupt",
	"detach",
	"kill",
]);

const FAMILY_LABELS: Record<ToolFamily, string> = {
	analysis: "Static analysis",
	debugger: "Live debugger",
	filesystem: "File system",
	shell: "Shell",
	memory: "Research memory",
	console: "Backend console",
	generic: "Unclassified tool",
};

const RISK_LABELS: Record<ToolRisk, string> = {
	observe: "Observe",
	mutate: "Mutate",
	execute: "Execute",
	unknown: "Unscoped",
};

/** Parse a tool argument payload without allowing malformed model output to break rendering. */
export function parseToolArguments(raw: string): Record<string, unknown> {
	if (raw.trim().length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>;
		}
		return { value: parsed };
	} catch {
		return { raw };
	}
}

/** Convert a JSON value into a compact human-readable label. */
export function formatToolValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (Array.isArray(value))
		return value.map((item) => formatToolValue(item)).join(", ");
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

/** Normalize numeric targets while preserving symbol names and malformed input. */
export function formatAddress(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) {
		return `0x${value.toString(16)}`;
	}
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (/^0x[0-9a-f]+$/i.test(text)) {
		const parsed = Number.parseInt(text.slice(2), 16);
		return Number.isSafeInteger(parsed) ? `0x${parsed.toString(16)}` : text;
	}
	if (/^\d+$/.test(text)) {
		const parsed = Number(text);
		return Number.isSafeInteger(parsed) ? `0x${parsed.toString(16)}` : text;
	}
	return text.length > 0 ? text : undefined;
}

/** Read a scalar tool argument as display text. */
export function getString(
	args: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	const text = formatToolValue(value);
	return text.length > 0 ? text : undefined;
}

/** Shorten a long argument or output for a dense summary row. */
export function shorten(value: string, max = 96): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Identify backend tool errors encoded as result text. */
export function isToolError(result?: string): boolean {
	const text = result?.trim().toLowerCase() ?? "";
	return (
		text.startsWith("tool error") ||
		text.startsWith("error:") ||
		text.startsWith("failed:")
	);
}

/** Create a display field when the argument has a value. */
function makeField(
	key: string,
	label: string,
	value: string | undefined,
	mono = false,
): ToolArgumentField | null {
	if (!value) return null;
	return { key, label, value, mono };
}

/** Remove absent fields while preserving the caller's display order. */
function makeFields(
	fields: Array<ToolArgumentField | null>,
): ToolArgumentField[] {
	return fields.filter((field): field is ToolArgumentField => field !== null);
}

/** Find the first present scalar argument from a prioritized key list. */
function firstString(
	args: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = getString(args, key);
		if (value) return value;
	}
	return undefined;
}

/** Format a process identifier for the debugger summary. */
function formatPid(args: Record<string, unknown>): string | undefined {
	const pid = getString(args, "pid");
	return pid ? `pid ${pid}` : undefined;
}

/** Create a human-readable fallback title for an unknown tool. */
function humanizeToolName(name: string): string {
	return name
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Build a view for a backend-neutral static-analysis operation. */
function analysisView(
	toolName: string,
	operation: string,
	args: Record<string, unknown>,
): ToolCallView {
	if (operation === "raw") return consoleView(toolName, args, true);
	const target =
		formatAddress(args.addr) ??
		getString(args, "query") ??
		(operation === "analyze" ||
		operation === "info" ||
		operation === "functions" ||
		operation === "strings" ||
		operation === "imports"
			? "active binary"
			: undefined);
	const targetLabel =
		operation === "strings" ||
		operation === "functions" ||
		operation === "imports"
			? getString(args, "query")
				? "Filter"
				: "Scope"
			: operation === "analyze" || operation === "info"
				? "Scope"
				: "Target";
	return {
		name: toolName,
		family: "analysis",
		familyLabel: FAMILY_LABELS.analysis,
		operation,
		operationLabel: ANALYSIS_LABELS[operation] ?? "Analyze binary",
		risk: "observe",
		riskLabel: RISK_LABELS.observe,
		targetLabel,
		target,
		summary: ANALYSIS_SUMMARIES[operation] ?? "Inspect the active binary",
		fields: makeFields([
			makeField("addr", "Address", formatAddress(args.addr), true),
			makeField("count", "Instructions", getString(args, "count")),
			makeField("query", "Filter", getString(args, "query")),
			makeField("direction", "Direction", getString(args, "direction")),
			makeField("limit", "Limit", getString(args, "limit")),
			makeField("cmd", "Command", getString(args, "cmd"), true),
		]),
	};
}

/** Build a view for a live debugger operation. */
function debugView(
	operation: string,
	args: Record<string, unknown>,
): ToolCallView {
	const target =
		firstString(args, [
			"path",
			"pid",
			"addr",
			"symbol",
			"name",
			"id",
			"data",
		]) ?? "live session";
	const targetLabel = getString(args, "path")
		? "Executable"
		: getString(args, "pid")
			? "Process"
			: getString(args, "addr") || getString(args, "symbol")
				? "Address"
				: getString(args, "name")
					? "Register"
					: "Target";
	const risk: ToolRisk = DEBUG_EXECUTE.has(operation)
		? "execute"
		: DEBUG_OBSERVE.has(operation)
			? "observe"
			: "mutate";
	return {
		name: "debug",
		family: "debugger",
		familyLabel: FAMILY_LABELS.debugger,
		operation,
		operationLabel: DEBUG_LABELS[operation] ?? "Debugger operation",
		risk,
		riskLabel: RISK_LABELS[risk],
		targetLabel,
		target: operation === "pid" ? formatPid(args) : target,
		summary:
			DEBUG_SUMMARIES[operation] ?? "Inspect or control the live target",
		fields: makeFields([
			makeField("path", "Executable", getString(args, "path"), true),
			makeField("pid", "PID", getString(args, "pid"), true),
			makeField("addr", "Address", formatAddress(args.addr), true),
			makeField("symbol", "Symbol", getString(args, "symbol"), true),
			makeField("id", "Breakpoint", getString(args, "id"), true),
			makeField("name", "Register", getString(args, "name"), true),
			makeField("value", "Value", getString(args, "value"), true),
			makeField("len", "Bytes", getString(args, "len"), true),
			makeField("format", "Format", getString(args, "format")),
			makeField("bytes", "Bytes", getString(args, "bytes"), true),
			makeField("data", "Input", getString(args, "data"), true),
			makeField("kind", "Step", getString(args, "kind")),
			makeField("thread", "Thread", getString(args, "thread"), true),
			makeField("count", "Instructions", getString(args, "count")),
		]),
	};
}

/** Build a view for a local filesystem operation. */
function filesystemView(
	name: string,
	args: Record<string, unknown>,
): ToolCallView {
	const path = getString(args, "filePath");
	const operation =
		name === "read" ? "read" : name === "write" ? "write" : "edit";
	const labels: Record<string, string> = {
		read: "Read file",
		write: "Write file",
		edit: "Patch file",
	};
	const summaries: Record<string, string> = {
		read: "Read local file contents",
		write: "Overwrite a local file",
		edit: "Replace exact text in a local file",
	};
	return {
		name,
		family: "filesystem",
		familyLabel: FAMILY_LABELS.filesystem,
		operation,
		operationLabel: labels[operation],
		risk: operation === "read" ? "observe" : "mutate",
		riskLabel: RISK_LABELS[operation === "read" ? "observe" : "mutate"],
		targetLabel: "Path",
		target: path,
		summary: summaries[operation],
		fields: makeFields([
			makeField("filePath", "Path", path, true),
			makeField("offset", "Start line", getString(args, "offset"), true),
			makeField("limit", "Line limit", getString(args, "limit"), true),
			makeField(
				"oldString",
				"Replace",
				getString(args, "oldString")
					? shorten(getString(args, "oldString") ?? "")
					: undefined,
				true,
			),
			makeField(
				"newString",
				"With",
				getString(args, "newString")
					? shorten(getString(args, "newString") ?? "")
					: undefined,
				true,
			),
			makeField(
				"replaceAll",
				"All matches",
				getString(args, "replaceAll"),
			),
		]),
	};
}

/** Build a view for a shell execution request. */
function shellView(name: string, args: Record<string, unknown>): ToolCallView {
	const command = getString(args, "command");
	return {
		name,
		family: "shell",
		familyLabel: FAMILY_LABELS.shell,
		operation: "bash",
		operationLabel: "Run shell command",
		risk: "execute",
		riskLabel: RISK_LABELS.execute,
		targetLabel: "Command",
		target: command ? shorten(command, 120) : undefined,
		summary: "Execute a command in the local shell",
		command,
		fields: makeFields([
			makeField(
				"workdir",
				"Working directory",
				getString(args, "workdir"),
				true,
			),
			makeField("timeout", "Timeout", getString(args, "timeout"), true),
		]),
	};
}

/** Build a view for a saved research-memory operation. */
function memoryView(
	operation: string,
	args: Record<string, unknown>,
): ToolCallView {
	const key = getString(args, "key");
	const query = getString(args, "query");
	const labels: Record<string, string> = {
		save: "Save finding",
		load: "Load finding",
		search: "Search findings",
	};
	const summaries: Record<string, string> = {
		save: "Persist a reverse-engineering note",
		load: "Retrieve a saved finding",
		search: "Search saved findings by keywords",
	};
	const risk: ToolRisk = operation === "save" ? "mutate" : "observe";
	return {
		name: `memory_${operation}`,
		family: "memory",
		familyLabel: FAMILY_LABELS.memory,
		operation,
		operationLabel: labels[operation] ?? "Research memory",
		risk,
		riskLabel: RISK_LABELS[risk],
		targetLabel: operation === "search" ? "Query" : "Key",
		target: operation === "search" ? query : key,
		summary: summaries[operation] ?? "Use project research memory",
		fields: makeFields([
			makeField("key", "Key", key, true),
			makeField("query", "Query", query, true),
			makeField("limit", "Limit", getString(args, "limit"), true),
		]),
	};
}

/** Build a view for a backend-native console command. */
function consoleView(
	name: string,
	args: Record<string, unknown>,
	analysisRaw = false,
): ToolCallView {
	const command = getString(args, "cmd") ?? getString(args, "command");
	return {
		name,
		family: "console",
		familyLabel: FAMILY_LABELS.console,
		operation: "raw",
		operationLabel: "Backend console",
		risk: "execute",
		riskLabel: RISK_LABELS.execute,
		targetLabel: "Command",
		target: command ? shorten(command, 120) : undefined,
		summary: analysisRaw
			? "Run a backend-native analysis command"
			: "Run a raw analysis console command",
		command,
		fields: makeFields([makeField("cmd", "Command", command, true)]),
	};
}

/** Build a conservative fallback for a tool outside the known schema. */
function genericView(
	name: string,
	args: Record<string, unknown>,
): ToolCallView {
	return {
		name,
		family: "generic",
		familyLabel: FAMILY_LABELS.generic,
		operation: name,
		operationLabel: humanizeToolName(name) || "Tool call",
		risk: "unknown",
		riskLabel: RISK_LABELS.unknown,
		targetLabel: "Input",
		target: firstString(args, ["command", "query", "path", "filePath"]),
		summary: "Arguments were not matched to a known tool schema",
		fields: makeFields(
			Object.entries(args)
				.slice(0, 5)
				.map(([key, value]) =>
					makeField(
						key,
						humanizeToolName(key),
						shorten(formatToolValue(value)),
						true,
					),
				),
		),
	};
}

/** Classify a tool call into a domain-specific, risk-aware chat representation. */
export function classifyToolCall(
	name: string,
	rawArguments: string,
): ToolCallView {
	const normalized = name.trim().toLowerCase();
	const args = parseToolArguments(rawArguments);
	if (
		normalized === "analyze" ||
		Object.prototype.hasOwnProperty.call(ANALYSIS_LABELS, normalized)
	) {
		const operation =
			normalized === "analyze"
				? (getString(args, "op") ?? "analyze")
				: normalized;
		return analysisView(name || normalized, operation, args);
	}
	if (normalized === "debug")
		return debugView(getString(args, "op") ?? "status", args);
	if (["read", "write", "edit"].includes(normalized)) {
		return filesystemView(normalized, args);
	}
	if (["bash", "shell", "exec"].includes(normalized)) {
		return shellView(name || normalized, args);
	}
	if (normalized.startsWith("memory_")) {
		return memoryView(normalized.slice("memory_".length), args);
	}
	if (["raw", "console"].includes(normalized))
		return consoleView(name || normalized, args);
	return genericView(name || "tool", args);
}

/** Type-guard a parsed JSON object for result inspection. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read a scalar result value as compact display text. */
function resultValue(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = formatToolValue(value);
	return text.length > 0 ? text : undefined;
}

/** Append a result fact only when its value is present. */
function addResultFact(
	facts: ToolResultFact[],
	label: string,
	value: unknown,
	tone?: ToolResultFact["tone"],
): void {
	const text = resultValue(value);
	if (text) facts.push({ label, value: shorten(text, 88), tone });
}

/** Add a numeric-looking result value with a stable suffix. */
function addCountFact(
	facts: ToolResultFact[],
	label: string,
	value: unknown,
): void {
	const text = resultValue(value);
	if (text) facts.push({ label, value: text, tone: "default" });
}

/** Inspect a tool result for compact, operation-specific evidence chips. */
export function getToolResultFacts(
	view: ToolCallView,
	result?: string,
): ToolResultFact[] {
	if (!result || isToolError(result)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(result);
	} catch {
		if (view.family === "shell" || view.family === "console") return [];
		return [{ label: "Output", value: shorten(result.trim(), 88) }];
	}
	const facts: ToolResultFact[] = [];
	if (Array.isArray(parsed)) {
		if (view.family === "debugger") {
			addCountFact(
				facts,
				view.operation === "backtrace" ? "Frames" : "Instructions",
				parsed.length,
			);
		} else {
			addCountFact(facts, "Items", parsed.length);
		}
		const first = parsed[0];
		if (isRecord(first)) {
			addResultFact(
				facts,
				"First",
				first.name ?? formatAddress(first.addr) ?? first.text,
			);
		}
		return facts;
	}
	if (!isRecord(parsed)) {
		if (view.family === "shell" || view.family === "console") return [];
		return [{ label: "Output", value: shorten(result, 88) }];
	}
	addCountFact(facts, "Count", parsed.count);
	addCountFact(facts, "Showing", parsed.showing);
	if (parsed.truncated === true) {
		facts.push({ label: "Truncated", value: "yes", tone: "warning" });
	}
	if (view.operation === "info") {
		const info = isRecord(parsed.info) ? parsed.info : parsed;
		addResultFact(facts, "Format", info.format ?? info.file);
		addResultFact(facts, "Arch", info.arch ?? info.machine);
		addCountFact(facts, "Bits", info.bits);
		addResultFact(facts, "Entry", formatAddress(info.entry));
	}
	if (view.operation === "analyze" && parsed.ok === true) {
		facts.push({ label: "Index", value: "ready" });
	}
	if (view.family === "analysis" && view.operation === "disasm") {
		addResultFact(facts, "Function", parsed.name, "default");
		addResultFact(facts, "Address", formatAddress(parsed.addr), "default");
	}
	if (view.family === "analysis" && view.operation === "graph") {
		addResultFact(facts, "Function", parsed.name, "default");
		addResultFact(facts, "Address", formatAddress(parsed.addr), "default");
		addCountFact(
			facts,
			"Blocks",
			Array.isArray(parsed.blocks) ? parsed.blocks.length : undefined,
		);
	}
	if (view.family === "debugger") {
		if (view.operation === "regs") {
			addResultFact(facts, "PC", formatAddress(parsed.pc), "default");
			addResultFact(facts, "SP", formatAddress(parsed.sp), "default");
			addResultFact(facts, "FP", formatAddress(parsed.fp), "default");
			const values = isRecord(parsed.values)
				? Object.keys(parsed.values).length
				: undefined;
			addCountFact(facts, "Registers", values);
		}
		if (view.operation === "read") {
			addResultFact(
				facts,
				"Address",
				formatAddress(parsed.addr),
				"default",
			);
			addCountFact(facts, "Bytes", parsed.len);
			addResultFact(facts, "Hex", parsed.hex, "default");
			addResultFact(facts, "ASCII", parsed.ascii, "default");
			addCountFact(
				facts,
				"Words",
				Array.isArray(parsed.words) ? parsed.words.length : undefined,
			);
		}
		if (view.operation === "status") {
			addResultFact(facts, "State", parsed.state, "default");
			addResultFact(
				facts,
				"PID",
				formatPid({ pid: parsed.pid }),
				"default",
			);
			const stop = isRecord(parsed.stop) ? parsed.stop : undefined;
			addResultFact(
				facts,
				"Stop",
				stop?.reason ?? parsed.reason,
				"default",
			);
		}
		if (view.operation === "write" || view.operation === "stdin") {
			addCountFact(facts, "Written", parsed.written);
		}
		if (view.operation === "backtrace" || view.operation === "threads") {
			addCountFact(
				facts,
				"Entries",
				Array.isArray(parsed) ? parsed.length : undefined,
			);
		}
	}
	if (view.family === "memory" && view.operation === "load") {
		const text = resultValue(parsed.content ?? parsed.text);
		if (text)
			facts.push({ label: "Stored note", value: shorten(text, 88) });
	}
	return facts.slice(0, 6);
}

/** Pretty-print JSON results while preserving non-JSON terminal output. */
export function formatToolOutput(result: string): string {
	try {
		const parsed: unknown = JSON.parse(result);
		if (typeof parsed === "string") return parsed;
		return JSON.stringify(parsed, null, 2) ?? result;
	} catch {
		return result;
	}
}
