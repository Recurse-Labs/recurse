import { Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/api";
import { useBinaryStore } from "@/store/binaryStore";
import type { Recon } from "@/types";

/** Human-readable byte size. */
function fmtBytes(n: unknown): string {
	if (typeof n !== "number")
		return n === undefined || n === null ? "" : String(n);
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(2)} ${units[i]}`;
}

/** Percentage from a 0–1 fraction. */
function fmtPct(n: unknown): string {
	return typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "";
}

/** Fixed display order and labels for the info block. */
const INFO_ORDER: [string, string][] = [
	["file", "File"],
	["format", "Format"],
	["bits", "Bits"],
	["class", "Class"],
	["mode", "Mode"],
	["size", "Size"],
	["type", "Type"],
	["language", "Language"],
	["arch", "Architecture"],
	["base_addr", "Base addr"],
	["virtual_addr", "Virtual addr"],
	["canary", "Canary"],
	["crypto", "Crypto"],
	["machine", "Machine"],
	["os", "OS"],
	["stripped", "Stripped"],
	["relocs", "Relocs"],
	["endian", "Endianness"],
	["pic", "PIC"],
	["static", "Static"],
	["compiler", "Compiler"],
];

function renderValue(key: string, v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "boolean") return v ? "True" : "False";
	if (key === "size") return fmtBytes(v);
	return String(v);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 items-center gap-2">
			<span className="text-muted-foreground w-24 shrink-0 truncate text-right text-xs">
				{label}
			</span>
			<span
				className="bg-muted/40 min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-xs"
				title={value}
			>
				{value}
			</span>
		</div>
	);
}

function Bar({ value }: { value: string }) {
	return (
		<span
			className="bg-muted/40 truncate rounded px-2 py-1 font-mono text-xs"
			title={value}
		>
			{value}
		</span>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="min-w-0">
			<h3 className="label mb-2">{title}</h3>
			{children}
		</section>
	);
}

/**
 * Reconnaissance dashboard: binary info, hashes, linked libraries, a
 * self-contained hardening report (RELRO / PIE / NX / canary / FORTIFY) and
 * analysis counts. Fetched once per opened binary.
 */
export function ReconPanel() {
	const binary = useBinaryStore((s) => s.binary);
	const [recon, setRecon] = useState<Recon | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [reportStatus, setReportStatus] = useState<string | null>(null);
	const [reportBusy, setReportBusy] = useState(false);

	const exportReport = async () => {
		setReportBusy(true);
		setReportStatus(null);
		try {
			const res = await api.generateReport();
			setReportStatus(
				`${res.finding_count} finding${res.finding_count === 1 ? "" : "s"} written to ${res.path}`,
			);
		} catch (e) {
			setReportStatus(`Report failed: ${String(e)}`);
		} finally {
			setReportBusy(false);
		}
	};

	useEffect(() => {
		let cancelled = false;
		api.recon()
			.then((r) => {
				if (!cancelled) setRecon(r);
			})
			.catch((e) => {
				if (!cancelled) setError(String(e));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [binary?.path]);

	if (loading) {
		return (
			<div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-xs">
				<Loader2 className="h-3.5 w-3.5 animate-spin" />
				gathering reconnaissance…
			</div>
		);
	}
	if (error) {
		return (
			<div className="border-destructive bg-destructive/10 text-destructive m-3 rounded-md border p-2.5 text-xs">
				{error}
			</div>
		);
	}
	if (!recon) return null;

	const info = recon.info ?? {};
	const checksec = recon.checksec ?? {};
	const analysis = recon.analysis ?? {};
	const hashes = recon.hashes;
	const shown = new Set(INFO_ORDER.map(([k]) => k));
	const extraKeys = Object.keys(info).filter((k) => !shown.has(k));

	return (
		<div className="scroll-host min-h-0 flex-1 overflow-auto px-4 py-3">
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-lg font-bold tracking-tight">Overview</h2>
				<div className="flex items-center gap-2">
					{reportStatus && (
						<span className="text-muted-foreground max-w-sm truncate text-[11px]">
							{reportStatus}
						</span>
					)}
					<Button
						size="sm"
						variant="outline"
						onClick={() => void exportReport()}
						disabled={reportBusy}
					>
						{reportBusy ? "Generating…" : "Export report"}
					</Button>
				</div>
			</div>

			<Section title="Info">
				<div className="grid grid-cols-1 gap-1.5 lg:grid-cols-2 xl:grid-cols-3">
					{INFO_ORDER.map(([key, label]) => (
						<Field
							key={key}
							label={label}
							value={renderValue(key, info[key])}
						/>
					))}
					{extraKeys.map((key) => (
						<Field
							key={key}
							label={key}
							value={renderValue(key, info[key])}
						/>
					))}
				</div>
			</Section>

			<div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
				<Section title="Hashes">
					<div className="flex flex-col gap-1.5">
						{hashes && (
							<>
								<Field label="MD5" value={hashes.md5} />
								<Field label="SHA1" value={hashes.sha1} />
								<Field label="SHA256" value={hashes.sha256} />
								<Field label="CRC32" value={hashes.crc32} />
							</>
						)}
						<Field
							label="Entropy"
							value={recon.entropy?.toFixed(6) ?? ""}
						/>
						<Field
							label="Temperature"
							value={recon.temperature?.toFixed(6) ?? ""}
						/>
					</div>
				</Section>

				<Section title="Libraries">
					<div className="flex flex-col gap-1.5">
						{recon.libraries.length === 0 ? (
							<span className="text-muted-foreground text-xs">
								no dynamic libraries
							</span>
						) : (
							recon.libraries.map((lib) => (
								<Bar key={lib} value={lib} />
							))
						)}
					</div>
				</Section>
			</div>

			<div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
				<Section title="Hardening">
					<div className="flex flex-col gap-1.5">
						<Field label="RELRO" value={checksec.relro ?? ""} />
						<Field label="Canary" value={checksec.canary ?? ""} />
						<Field label="NX" value={checksec.nx ?? ""} />
						<Field label="PIE" value={checksec.pie ?? ""} />
						<Field label="RPATH" value={checksec.rpath ?? ""} />
						<Field label="RUNPATH" value={checksec.runpath ?? ""} />
						<Field label="FORTIFY" value={checksec.fortify ?? ""} />
						<Field
							label="Fortified"
							value={String(checksec.fortified ?? "")}
						/>
						<Field
							label="Fortifiable"
							value={String(checksec.fortifiable ?? "")}
						/>
					</div>
				</Section>

				<Section title="Analysis info">
					<div className="flex flex-col gap-1.5">
						<Field
							label="Functions"
							value={String(analysis.functions ?? "")}
						/>
						<Field
							label="X-Refs"
							value={String(analysis.xrefs ?? "")}
						/>
						<Field
							label="Calls"
							value={String(analysis.calls ?? "")}
						/>
						<Field
							label="Strings"
							value={String(analysis.strings ?? "")}
						/>
						<Field
							label="Symbols"
							value={String(analysis.symbols ?? "")}
						/>
						<Field
							label="Imports"
							value={String(analysis.imports ?? "")}
						/>
						<Field
							label="Coverage"
							value={fmtPct(analysis.coverage)}
						/>
					</div>
				</Section>
			</div>
		</div>
	);
}
