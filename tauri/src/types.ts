export interface BinaryInfo {
	path: string;
	backend?: Backend;
	capabilities?: {
		decompile: boolean;
		raw: boolean;
		graph: boolean;
		xrefs_from: boolean;
	};
	info: {
		bin?: {
			arch?: string;
			bits?: number;
			type?: string | null;
			/** Entry-point address, when the backend reports one. */
			entry?: number;
			[k: string]: unknown;
		};
		[k: string]: unknown;
	};
	function_count: number;
	string_count: number;
}

/** Hardening report (checksec-style) for the recon page. */
export interface ReconChecksec {
	relro?: string;
	canary?: string;
	nx?: string;
	pie?: string;
	rpath?: string;
	runpath?: string;
	fortify?: string;
	fortified?: number;
	fortifiable?: number;
}

/** File hashes for the recon page. */
export interface ReconHashes {
	md5: string;
	sha1: string;
	sha256: string;
	crc32: string;
}

/** Analysis counts for the recon page. */
export interface ReconAnalysis {
	functions?: number;
	xrefs?: number;
	calls?: number;
	strings?: number;
	symbols?: number;
	imports?: number;
	coverage?: number;
}

/** Reconnaissance summary rendered by the recon page. */
export interface Recon {
	info: Record<string, unknown>;
	checksec: ReconChecksec;
	libraries: string[];
	analysis: ReconAnalysis;
	hashes: ReconHashes;
	entropy: number;
	temperature: number;
}

export interface Function {
	addr: number;
	name?: string;
	realname?: string;
	size?: number;
	signature?: string;
	[k: string]: unknown;
}

export interface AsmInsn {
	addr: number;
	text?: string;
	disasm?: string;
	bytes?: string | null;
	esil?: string | null;
	jump?: number | null;
	ptr?: number | null;
	[k: string]: unknown;
}

export interface AsmResult {
	name?: string;
	addr?: number;
	size?: number;
	ops?: AsmInsn[];
	[k: string]: unknown;
}

export interface R2String {
	vaddr: number;
	string: string;
	type?: string;
	[k: string]: unknown;
}

export interface Import {
	name?: string;
	[k: string]: unknown;
}

export interface Xref {
	from: number;
	type?: string;
	fcn_name?: string;
	opcode?: string;
	[k: string]: unknown;
}

export interface DecompileAnnotation {
	start: number;
	end: number;
	type?: string;
	name?: string;
	offset?: number;
	syntax_highlight?: string;
	[k: string]: unknown;
}

export interface DecompileResult {
	code?: string;
	annotations?: DecompileAnnotation[];
	[k: string]: unknown;
}

export type CenterTab =
	| "recon"
	| "disasm"
	| "strings"
	| "imports"
	| "console"
	| "debug"
	| "findings"
	| "hex"
	| "callgraph";

export interface ModelInfo {
	id: string;
	name: string;
	context_length: number;
	prompt_price: string;
	free: boolean;
}

export interface LlmStatus {
	provider: string;
	configured: boolean;
	model: string;
	/** Normalized completions URL the agent calls. */
	endpoint: string;
	/** True for a custom/local OpenAI-compatible endpoint (no key required). */
	custom: boolean;
}
export interface ProviderStatus {
	id: string;
	name: string;
	/** "api_key" | "oauth_anthropic" | "oauth_github_copilot" | "local" */
	auth_kind: "api_key" | "oauth_anthropic" | "oauth_github_copilot" | "local";
	docs_url: string;
	configured: boolean;
	oauth_expires_at: number | null;
	is_active: boolean;
}

export interface AnthropicLoginStart {
	authorize_url: string;
	verifier: string;
}

export interface DeviceLoginInfo {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval_secs: number;
	expires_in_secs: number;
}

/** Analysis backend implementations selectable at runtime. */
export type Backend = "r2" | "native" | "ida";

export interface Project {
	name: string;
	binary_path: string;
	created_at: number;
	updated_at: number;
}

export interface ToolCallFn {
	name: string;
	arguments: string;
}

export interface ToolCall {
	id: string;
	type: string;
	function: ToolCallFn;
}

export interface ChatMessage {
	role: string;
	content: string | null;
	tool_calls?: ToolCall[] | null;
	tool_call_id?: string | null;
	reasoning?: string | null;
}

export type AgentEventKind =
	"reasoning" | "token" | "tool_call" | "tool_result" | "done" | "error";

export interface AgentEvent {
	kind: AgentEventKind;
	run_id: string;
	delta?: string;
	content?: string;
	message?: string;
	id?: string;
	name?: string;
	arguments?: string;
	result?: string;
}

export interface ContextItem {
	id: string;
	source: "disasm" | "decompile" | "string" | "function";
	label: string;
	text: string;
}

export interface PendingSelection {
	label: string;
	text: string;
	source: ContextItem["source"];
}

export interface GraphOp {
	addr: number;
	disasm?: string;
	bytes?: string | null;
	type?: string;
	jump?: number | null;
	fail?: number | null;
	[k: string]: unknown;
}

export interface GraphBlock {
	addr: number;
	ninstr?: number;
	size?: number;
	jump?: number | null;
	fail?: number | null;
	/** Extra successors of a computed jump (jump-table / switch cases). */
	targets?: number[];
	ops?: GraphOp[];
	[k: string]: unknown;
}

/**
 * Canonical control-flow graph. Both engines produce exactly this shape — r2's
 * output is transformed into it host-side — so the graph UI is
 * backend-agnostic.
 */
export interface FunctionGraph {
	addr: number;
	name?: string;
	blocks?: GraphBlock[];
	[k: string]: unknown;
}

export interface DebugRegisters {
	pc: number;
	sp: number;
	fp: number;
	values: Record<string, number>;
}

/** A tagged stop reason (`{reason: "breakpoint", addr, id}`, …). */
export interface DebugStopReason {
	reason: string;
	addr?: number;
	id?: number;
	signal?: number;
	name?: string;
	code?: number;
}

export interface DebugStop {
	pid: number;
	thread: number;
	reason: DebugStopReason;
	registers: DebugRegisters;
}

export interface DebugBreakpoint {
	id: number;
	addr: number;
	enabled: boolean;
}

export interface DebugFrame {
	addr: number;
	name?: string;
}

export interface DebugStatus {
	pid?: number | null;
	state: string;
	stop?: DebugStopReason;
	breakpoints: DebugBreakpoint[];
}

/** Live session snapshot, published by the debugger for follow-along. */
export interface DebugSnapshot {
	pid?: number | null;
	state: string;
	stop?: DebugStop | null;
	breakpoints: DebugBreakpoint[];
	frames: DebugFrame[];
	/** `runtime - static` address (ASLR/PIE load bias). */
	bias: number;
}

/** One instruction decoded from the debuggee's live memory. */
export interface DebugInsn {
	addr: number;
	bytes: string;
	text: string;
}

/** A rendered memory read. */
export interface DebugMemory {
	addr: number;
	len?: number;
	hex?: string;
	ascii?: string;
	words?: number[];
}

export interface Session {
	id: string;
	name: string;
	model: string;
	created_at: number;
	updated_at: number;
}

// ---------------------------------------------------------------------------
// Findings: capa capabilities, C++ classes, driver IOCTLs, firmware, DWARF.
// ---------------------------------------------------------------------------

export interface CapaMatch {
	name: string;
	namespace: string;
	description: string;
}

export interface VirtualFunctionInfo {
	slot: number;
	address: number;
	name: string | null;
}

export interface ClassInfo {
	name: string;
	vtable_address: number;
	address_point: number;
	typeinfo_address: number | null;
	bases: string[];
	virtual_functions: VirtualFunctionInfo[];
}

export interface FirmwareMatch {
	offset: number;
	signature: string;
}

export interface DwarfParameterInfo {
	name: string;
	ty: string;
}

export interface DwarfFunctionInfo {
	name: string;
	low_pc: number | null;
	high_pc: number | null;
	return_type: string | null;
	parameters: DwarfParameterInfo[];
}

export interface DriverIoctl {
	function_addr: number;
	function_name: string;
	compare_addr: number;
	handler_addr: number | null;
	code: {
		raw: number;
		device_type: number;
		function: number;
		method: string;
		access: string;
	};
}

export interface Findings {
	capabilities: CapaMatch[];
	classes: ClassInfo[];
	firmware: FirmwareMatch[];
	dwarf_functions: DwarfFunctionInfo[];
	driver_ioctls: DriverIoctl[];
	driver_ioctls_truncated: boolean;
	scanned_functions: number;
	total_functions: number;
}

// ---------------------------------------------------------------------------
// Binary diff.
// ---------------------------------------------------------------------------

export interface DiffMatch {
	a: number;
	b: number;
	name_a: string;
	name_b: string;
	confidence: number;
	method: "exact" | "fuzzy";
}

export interface DiffAddrName {
	addr: number;
	name: string;
}

export interface DiffResult {
	matched: DiffMatch[];
	removed: DiffAddrName[];
	added: DiffAddrName[];
	a_function_count: number;
	b_function_count: number;
}

// ---------------------------------------------------------------------------
// Signature generation + cross-binary semantic similarity.
// ---------------------------------------------------------------------------

export interface GeneratedSignature {
	name: string;
	addr: number;
	pattern: string;
	byte_count: number;
	concrete_byte_count: number;
}

export interface SemanticMatch {
	binary: string;
	name: string;
	address: number;
	similarity: number;
}

export interface SemanticSimilarResult {
	query_addr: number;
	corpus_size: number;
	matches: SemanticMatch[];
}

export interface SemanticIndexResult {
	indexed: number;
	corpus_size: number;
}

// ---------------------------------------------------------------------------
// Whole-binary call graph.
// ---------------------------------------------------------------------------

export interface CallGraphNode {
	addr: number;
	name: string;
	is_leaf: boolean;
	is_called: boolean;
}

export interface CallGraphEdge {
	from: number;
	to: number;
}

export interface CallGraph {
	nodes: CallGraphNode[];
	edges: CallGraphEdge[];
	truncated: boolean;
	total_functions: number;
}

// ---------------------------------------------------------------------------
// Report export.
// ---------------------------------------------------------------------------

export interface GeneratedReport {
	path: string;
	markdown: string;
	finding_count: number;
}

// ---------------------------------------------------------------------------
// Debug call/stop trace.
// ---------------------------------------------------------------------------

export interface DebugTraceEntry {
	pid: number;
	thread: number;
	reason: DebugStopReason;
	registers: DebugRegisters;
}
