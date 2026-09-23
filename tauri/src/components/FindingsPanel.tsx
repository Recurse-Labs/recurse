import { Loader2, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/api";
import { useBinaryStore } from "@/store/binaryStore";
import type { Findings } from "@/types";

function fmtAddr(a?: number | null): string {
	return typeof a === "number" ? `0x${a.toString(16)}` : "";
}

function Section({
	title,
	count,
	children,
}: {
	title: string;
	count: number;
	children: ReactNode;
}) {
	return (
		<section className="mb-6">
			<h3 className="mb-2 flex items-center gap-2 text-sm font-bold tracking-wide uppercase">
				{title}
				<span className="text-muted-foreground text-xs font-normal normal-case">
					{count}
				</span>
			</h3>
			{children}
		</section>
	);
}

function Empty({ label }: { label: string }) {
	return <div className="text-muted-foreground text-xs italic">{label}</div>;
}

/**
 * Combined findings dashboard: capa-style capability matches, C++
 * vtable/RTTI-recovered classes, kernel driver IOCTL dispatch candidates,
 * firmware format signature hits, and DWARF debug-info functions — one
 * call to the host's `findings` command, which itself degrades each
 * sub-scan independently (see `analysis_extra::findings` on the host).
 */
export function FindingsPanel() {
	const binary = useBinaryStore((s) => s.binary);
	const [findings, setFindings] = useState<Findings | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const run = async () => {
		setLoading(true);
		setError(null);
		try {
			setFindings(await api.findings());
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	if (!findings && !loading && !error) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
				<p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
					Scan {binary ? "the active binary" : "this binary"} for
					capa-style capability matches, C++ vtable/RTTI classes,
					kernel driver IOCTL dispatch sites, firmware format
					signatures, and DWARF debug info.
				</p>
				<Button size="sm" onClick={() => void run()}>
					Run findings scan
				</Button>
			</div>
		);
	}

	if (loading) {
		return (
			<div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-xs">
				<Loader2 className="h-3.5 w-3.5 animate-spin" />
				scanning…
			</div>
		);
	}

	if (error) {
		return (
			<div className="border-destructive bg-destructive/10 text-destructive m-3 rounded-md border p-2.5 text-[11px]">
				{error}
				<div className="mt-2">
					<Button
						size="sm"
						variant="outline"
						onClick={() => void run()}
					>
						Retry
					</Button>
				</div>
			</div>
		);
	}

	if (!findings) return null;

	return (
		<div className="scroll-host min-h-0 flex-1 overflow-auto px-4 py-3">
			<div className="mb-4 flex items-center justify-between">
				<h2 className="text-lg font-bold tracking-tight">Findings</h2>
				<Button
					size="sm"
					variant="outline"
					onClick={() => void run()}
					disabled={loading}
				>
					<RefreshCw className="mr-1 h-3.5 w-3.5" /> Rescan
				</Button>
			</div>

			<p className="text-muted-foreground mb-4 text-[11px]">
				Scanned {findings.scanned_functions.toLocaleString()} of{" "}
				{findings.total_functions.toLocaleString()} functions.
				{findings.driver_ioctls_truncated
					? " Driver IOCTL scan was truncated at the function cap."
					: ""}
			</p>

			<Section title="Capabilities" count={findings.capabilities.length}>
				{findings.capabilities.length === 0 ? (
					<Empty label="no capa rule matches" />
				) : (
					<div className="flex flex-col gap-1.5">
						{findings.capabilities.map((c, i) => (
							<div
								key={`${c.name}-${i}`}
								className="bg-muted/40 rounded px-2.5 py-1.5 text-[11px]"
							>
								<div className="flex items-center gap-2">
									<span className="font-mono font-semibold">
										{c.name}
									</span>
									<span className="text-muted-foreground">
										{c.namespace}
									</span>
								</div>
								<div className="text-muted-foreground mt-0.5">
									{c.description}
								</div>
							</div>
						))}
					</div>
				)}
			</Section>

			<Section title="C++ classes" count={findings.classes.length}>
				{findings.classes.length === 0 ? (
					<Empty label="no vtables recovered (not a C++ Itanium-ABI binary, or fully stripped)" />
				) : (
					<div className="flex flex-col gap-2">
						{findings.classes.map((c) => (
							<div
								key={c.vtable_address}
								className="bg-muted/40 rounded px-2.5 py-1.5 text-[11px]"
							>
								<div className="font-mono font-semibold">
									{c.name}
									{c.bases.length > 0 && (
										<span className="text-muted-foreground">
											{" "}
											: {c.bases.join(", ")}
										</span>
									)}
								</div>
								<div className="text-muted-foreground mt-0.5 font-mono">
									vtable {fmtAddr(c.vtable_address)} ·{" "}
									{c.virtual_functions.length} virtual
									function
									{c.virtual_functions.length === 1
										? ""
										: "s"}
								</div>
							</div>
						))}
					</div>
				)}
			</Section>

			<Section
				title="Driver IOCTL dispatch"
				count={findings.driver_ioctls.length}
			>
				{findings.driver_ioctls.length === 0 ? (
					<Empty label="no cmp-against-immediate dispatch sites found" />
				) : (
					<table className="w-full font-mono text-[11px]">
						<thead>
							<tr className="text-muted-foreground text-left">
								<th className="py-1 pr-3">Code</th>
								<th className="py-1 pr-3">Method</th>
								<th className="py-1 pr-3">Access</th>
								<th className="py-1 pr-3">Compare</th>
								<th className="py-1">Handler</th>
							</tr>
						</thead>
						<tbody>
							{findings.driver_ioctls.map((h, i) => (
								<tr key={i} className="hover:bg-accent">
									<td className="py-0.5 pr-3">
										0x{h.code.raw.toString(16)}
									</td>
									<td
										className={
											h.code.method === "Neither"
												? "text-destructive py-0.5 pr-3"
												: "py-0.5 pr-3"
										}
									>
										{h.code.method}
									</td>
									<td className="py-0.5 pr-3">
										{h.code.access}
									</td>
									<td className="py-0.5 pr-3">
										{fmtAddr(h.compare_addr)}
									</td>
									<td className="py-0.5">
										{fmtAddr(h.handler_addr)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Section>

			<Section
				title="Firmware signatures"
				count={findings.firmware.length}
			>
				{findings.firmware.length === 0 ? (
					<Empty label="no embedded firmware/archive/filesystem signatures" />
				) : (
					<div className="flex flex-col gap-1">
						{findings.firmware.map((m, i) => (
							<div
								key={i}
								className="flex items-center gap-3 font-mono text-[11px]"
							>
								<span className="text-muted-foreground w-[10ch]">
									0x{m.offset.toString(16)}
								</span>
								<span>{m.signature}</span>
							</div>
						))}
					</div>
				)}
			</Section>

			<Section
				title="DWARF functions"
				count={findings.dwarf_functions.length}
			>
				{findings.dwarf_functions.length === 0 ? (
					<Empty label="no DWARF debug info (stripped, or not a DWARF-carrying build)" />
				) : (
					<div className="flex flex-col gap-1">
						{findings.dwarf_functions.slice(0, 200).map((f, i) => (
							<div key={i} className="font-mono text-[11px]">
								<span className="text-primary">
									{f.return_type ?? "void"}
								</span>{" "}
								<span className="font-semibold">{f.name}</span>(
								{f.parameters
									.map((p) => `${p.ty} ${p.name}`)
									.join(", ")}
								)
								{typeof f.low_pc === "number" && (
									<span className="text-muted-foreground">
										{" "}
										@ {fmtAddr(f.low_pc)}
									</span>
								)}
							</div>
						))}
						{findings.dwarf_functions.length > 200 && (
							<div className="text-muted-foreground text-[11px]">
								… {findings.dwarf_functions.length - 200} more
							</div>
						)}
					</div>
				)}
			</Section>
		</div>
	);
}
