import { useState } from "react";
import {
	Background,
	Controls,
	Handle,
	MarkerType,
	Position,
	ReactFlow,
	ReactFlowProvider,
	type Edge,
	type Node,
	type NodeProps,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/api";
import { cn } from "@/lib/utils";
import { useAnalysisStore } from "@/store/analysisStore";
import type { CallGraph } from "@/types";

function fmtAddr(a: number): string {
	return `0x${a.toString(16)}`;
}

type FnData = {
	addr: number;
	name: string;
	isLeaf: boolean;
	isCalled: boolean;
};
type FnNode = Node<FnData, "fnnode">;

function FnNodeComponent({ data }: NodeProps<FnNode>) {
	return (
		<div
			className={cn(
				"border-border bg-card rounded border px-2.5 py-1.5 font-mono text-[11px] shadow",
				!data.isCalled && "border-primary/60",
			)}
		>
			<Handle
				type="target"
				position={Position.Top}
				className="!opacity-0"
			/>
			<div className="text-primary truncate font-semibold">
				{data.name}
			</div>
			<div className="text-muted-foreground">{fmtAddr(data.addr)}</div>
			<Handle
				type="source"
				position={Position.Bottom}
				className="!opacity-0"
			/>
		</div>
	);
}

const nodeTypes = { fnnode: FnNodeComponent };

function layout(nodes: FnNode[], edges: Edge[]): FnNode[] {
	const g = new dagre.graphlib.Graph();
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({
		rankdir: "LR",
		nodesep: 24,
		ranksep: 90,
		marginx: 16,
		marginy: 16,
	});
	nodes.forEach((n) => g.setNode(n.id, { width: 160, height: 44 }));
	edges.forEach((e) => g.setEdge(e.source, e.target));
	dagre.layout(g);
	return nodes.map((n) => {
		const pos = g.node(n.id);
		return { ...n, position: { x: pos.x - 80, y: pos.y - 22 } };
	});
}

function toGraph(cg: CallGraph): { nodes: FnNode[]; edges: Edge[] } {
	const nodes: FnNode[] = cg.nodes.map((f) => ({
		id: String(f.addr),
		type: "fnnode",
		position: { x: 0, y: 0 },
		data: {
			addr: f.addr,
			name: f.name,
			isLeaf: f.is_leaf,
			isCalled: f.is_called,
		},
	}));
	const edges: Edge[] = cg.edges.map((e, i) => ({
		id: `e${i}-${e.from}-${e.to}`,
		source: String(e.from),
		target: String(e.to),
		markerEnd: { type: MarkerType.ArrowClosed },
		style: { stroke: "var(--muted-foreground)" },
	}));
	return { nodes, edges };
}

function Canvas() {
	const [nodes, setNodes, onNodesChange] = useNodesState<FnNode>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [meta, setMeta] = useState<{
		truncated: boolean;
		total: number;
	} | null>(null);
	const selectFn = useAnalysisStore((s) => s.selectFn);
	const funcs = useAnalysisStore((s) => s.funcs);

	const build = async () => {
		setLoading(true);
		setErr(null);
		try {
			const cg = await api.callGraph();
			const { nodes: ns, edges: es } = toGraph(cg);
			setNodes(layout(ns, es));
			setEdges(es);
			setMeta({ truncated: cg.truncated, total: cg.total_functions });
		} catch (e) {
			setErr(String(e));
		} finally {
			setLoading(false);
		}
	};

	const onNodeClick = (_: unknown, node: FnNode) => {
		const f = funcs.find((x) => x.addr === node.data.addr);
		if (f) selectFn(f);
	};

	return (
		<div className="flex h-full w-full flex-col">
			<div className="border-border bg-card flex items-center gap-2 border-b px-3 py-1.5">
				<Button
					size="sm"
					variant="outline"
					onClick={() => void build()}
				>
					{nodes.length > 0 ? "Rebuild" : "Build call graph"}
				</Button>
				{meta && (
					<span className="text-muted-foreground text-[11px]">
						{meta.total.toLocaleString()} functions
						{meta.truncated ? " (truncated)" : ""}
					</span>
				)}
				{loading && (
					<Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
				)}
			</div>
			<div className="min-h-0 flex-1">
				{err ? (
					<div className="border-destructive bg-destructive/10 text-destructive m-3 rounded-md border p-2.5 text-[11px]">
						{err}
					</div>
				) : nodes.length === 0 && !loading ? (
					<div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-xs">
						Aggregates call edges across every discovered function
						into one navigable graph — distinct from the
						per-function CFG in the disassembly view.
					</div>
				) : (
					<ReactFlow
						nodes={nodes}
						edges={edges}
						nodeTypes={nodeTypes}
						onNodesChange={onNodesChange}
						onEdgesChange={onEdgesChange}
						onNodeClick={onNodeClick}
						fitView
						fitViewOptions={{ padding: 0.15 }}
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable
						panOnScroll
						zoomOnScroll={false}
						zoomOnPinch
						zoomOnDoubleClick={false}
						minZoom={0.02}
						proOptions={{ hideAttribution: true }}
						className="bg-background"
					>
						<Background gap={18} size={1} />
						<Controls showInteractive={false} />
					</ReactFlow>
				)}
			</div>
		</div>
	);
}

/**
 * Whole-binary call graph: aggregates call edges across the binary's
 * functions (host-capped — see `analysis_extra::CALL_GRAPH_FUNCTION_CAP`)
 * into one navigable graph, distinct from `GraphPanel`'s per-function CFG.
 * Clicking a node selects that function everywhere else in the app.
 */
export function CallGraphPanel() {
	return (
		<div className="min-h-0 min-w-0 flex-1">
			<ReactFlowProvider>
				<Canvas />
			</ReactFlowProvider>
		</div>
	);
}
