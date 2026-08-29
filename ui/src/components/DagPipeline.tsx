import {
  Background,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type React from 'react';
import { useEffect, useRef } from 'react';
import type { TelemetryFrame } from '../../../src/core/types';

interface DagPipelineProps {
  metrics: TelemetryFrame['metrics'];
  workers: TelemetryFrame['workers'];
  trafficActive: boolean;
  routingStrategy: string;
}

interface CustomNodeData extends Record<string, unknown> {
  title: string;
  badge: string;
  badgeColor: string;
  value: string;
  valueColor: string;
  borderColor: string;
  hasTargetHandle?: boolean;
  hasSourceHandle?: boolean;
}

const CustomPipelineNode: React.FC<NodeProps<Node<CustomNodeData>>> = ({ data }) => {
  return (
    <div
      className={`dag-node-card bg-[#0f1522]/95 backdrop-blur-md border ${data.borderColor} rounded-xl p-3 min-w-[140px] text-center shadow-xl relative transition-colors duration-150`}
    >
      {data.hasTargetHandle && (
        <Handle
          type="target"
          position={Position.Left}
          className="!w-2 !h-2 !bg-[#64748b] !border-none"
        />
      )}

      <div
        className={`absolute -top-2.5 right-2 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${data.badgeColor}`}
      >
        {data.badge}
      </div>

      <div className="dag-title text-xs font-semibold text-white mt-1">{data.title}</div>
      <div className={`font-mono text-[11px] font-medium mt-1 ${data.valueColor}`}>
        {data.value}
      </div>

      {data.hasSourceHandle && (
        <Handle
          type="source"
          position={Position.Right}
          className="!w-2 !h-2 !bg-[#64748b] !border-none"
        />
      )}
    </div>
  );
};

const nodeTypes = {
  pipelineNode: CustomPipelineNode,
};

const INITIAL_NODES: Node<CustomNodeData>[] = [
  {
    id: 'traffic',
    type: 'pipelineNode',
    position: { x: 0, y: 80 },
    data: {
      title: 'Traffic Client',
      badge: 'IDLE',
      badgeColor: 'bg-white/10 text-[#94a3b8] border-white/20 dag-badge-idle',
      value: '0 req/s',
      valueColor: 'text-[#00f0ff]',
      borderColor: 'border-white/10',
      hasTargetHandle: false,
      hasSourceHandle: true,
    },
  },
  {
    id: 'ingress',
    type: 'pipelineNode',
    position: { x: 210, y: 80 },
    data: {
      title: 'Ingress Gateway',
      badge: '<10ms',
      badgeColor: 'bg-[#00f0ff]/20 text-[#00f0ff] border-[#00f0ff]',
      value: 'P50: 0.0ms',
      valueColor: 'text-[#00f0ff]',
      borderColor: 'border-white/10 hover:border-[#00f0ff]/60',
      hasTargetHandle: true,
      hasSourceHandle: true,
    },
  },
  {
    id: 'buffer',
    type: 'pipelineNode',
    position: { x: 420, y: 80 },
    data: {
      title: 'Shock Buffer',
      badge: '0% FULL',
      badgeColor: 'bg-[#a855f7]/20 text-[#a855f7] border-[#a855f7]',
      value: '0 tasks',
      valueColor: 'text-[#a855f7]',
      borderColor: 'border-white/10 hover:border-[#a855f7]/60',
      hasTargetHandle: true,
      hasSourceHandle: true,
    },
  },
  {
    id: 'router',
    type: 'pipelineNode',
    position: { x: 630, y: 80 },
    data: {
      title: 'Worker Pool',
      badge: 'LEAST-CONN',
      badgeColor: 'bg-[#10b981]/20 text-[#10b981] border-[#10b981]',
      value: '8 Nodes',
      valueColor: 'text-[#10b981]',
      borderColor: 'border-white/10 hover:border-[#10b981]/60',
      hasTargetHandle: true,
      hasSourceHandle: true,
    },
  },
  {
    id: 'downstream',
    type: 'pipelineNode',
    position: { x: 840, y: 15 },
    data: {
      title: 'Mock API / DB',
      badge: 'HEALTHY',
      badgeColor: 'bg-[#10b981]/20 text-[#10b981] border-[#10b981]',
      value: '200 OK',
      valueColor: 'text-[#10b981]',
      borderColor: 'border-white/10 hover:border-[#10b981]/60',
      hasTargetHandle: true,
      hasSourceHandle: false,
    },
  },
  {
    id: 'dlq',
    type: 'pipelineNode',
    position: { x: 840, y: 145 },
    data: {
      title: 'Dead-Letter Queue',
      badge: 'DLQ',
      badgeColor: 'bg-white/10 text-[#94a3b8] border-white/20',
      value: '0 fails',
      valueColor: 'text-[#f43f5e]',
      borderColor: 'border-white/10 hover:border-[#f43f5e]/60',
      hasTargetHandle: true,
      hasSourceHandle: false,
    },
  },
];

const INITIAL_EDGES = [
  {
    id: 'e-traffic-ingress',
    source: 'traffic',
    target: 'ingress',
    animated: false,
    style: { stroke: '#00f0ff', strokeWidth: 2 },
  },
  {
    id: 'e-ingress-buffer',
    source: 'ingress',
    target: 'buffer',
    animated: false,
    style: { stroke: '#a855f7', strokeWidth: 2 },
  },
  {
    id: 'e-buffer-router',
    source: 'buffer',
    target: 'router',
    animated: false,
    style: { stroke: '#10b981', strokeWidth: 2 },
  },
  {
    id: 'e-router-downstream',
    source: 'router',
    target: 'downstream',
    animated: false,
    style: { stroke: '#10b981', strokeWidth: 2 },
  },
  {
    id: 'e-router-dlq',
    source: 'router',
    target: 'dlq',
    animated: false,
    style: { stroke: '#f43f5e', strokeWidth: 2 },
  },
];

const DagFlowInner: React.FC<DagPipelineProps> = ({
  metrics,
  workers,
  trafficActive,
  routingStrategy,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(INITIAL_EDGES);
  const { fitView } = useReactFlow();

  // Auto-resize on container or window resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Initial fit
    const timer = setTimeout(() => {
      fitView({ padding: 0.15 });
    }, 50);

    const observer = new ResizeObserver(() => {
      fitView({ padding: 0.15 });
    });

    observer.observe(el);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [fitView]);

  // Update node data smoothly when telemetry arrives WITHOUT resetting layout or positions
  useEffect(() => {
    const openBreakers = workers.filter((w) => w.circuitState === 'OPEN').length;

    setNodes((current) =>
      current.map((n) => {
        if (n.id === 'traffic') {
          return {
            ...n,
            data: {
              ...n.data,
              badge: trafficActive ? 'BURSTING' : 'IDLE',
              badgeColor: trafficActive
                ? 'bg-[#00f0ff]/20 text-[#00f0ff] border-[#00f0ff]'
                : 'bg-white/10 text-[#94a3b8] border-white/20 dag-badge-idle',
              value: `${metrics.incomingRps.toLocaleString()} req/s`,
              borderColor: trafficActive ? 'border-[#00f0ff]/60' : 'border-white/10',
            },
          };
        }
        if (n.id === 'ingress') {
          return {
            ...n,
            data: {
              ...n.data,
              value: `P50: ${metrics.p50LatencyMs.toFixed(1)}ms`,
            },
          };
        }
        if (n.id === 'buffer') {
          return {
            ...n,
            data: {
              ...n.data,
              badge: `${metrics.bufferUtilizationPct}% FULL`,
              value: `${metrics.bufferDepth.toLocaleString()} tasks`,
            },
          };
        }
        if (n.id === 'router') {
          return {
            ...n,
            data: {
              ...n.data,
              badge: routingStrategy.replace('_', '-'),
              value: `${workers.length} Nodes`,
            },
          };
        }
        if (n.id === 'downstream') {
          return {
            ...n,
            data: {
              ...n.data,
              badge: openBreakers > 0 ? `${openBreakers} OPEN` : 'HEALTHY',
              badgeColor:
                openBreakers > 0
                  ? 'bg-[#f43f5e]/20 text-[#f43f5e] border-[#f43f5e]'
                  : 'bg-[#10b981]/20 text-[#10b981] border-[#10b981]',
              value: metrics.drainedRps > 0 ? `${metrics.drainedRps.toLocaleString()}/s` : '200 OK',
            },
          };
        }
        if (n.id === 'dlq') {
          return {
            ...n,
            data: {
              ...n.data,
              badgeColor:
                metrics.dlqSize > 0
                  ? 'bg-[#f43f5e]/20 text-[#f43f5e] border-[#f43f5e]'
                  : 'bg-white/10 text-[#94a3b8] border-white/20',
              value: `${metrics.dlqSize} fails`,
            },
          };
        }
        return n;
      })
    );

    setEdges((curEdges) =>
      curEdges.map((edge) => {
        if (edge.id === 'e-traffic-ingress') {
          return { ...edge, animated: trafficActive };
        }
        if (edge.id === 'e-ingress-buffer') {
          return { ...edge, animated: metrics.acceptedRps > 0 };
        }
        if (edge.id === 'e-buffer-router' || edge.id === 'e-router-downstream') {
          return { ...edge, animated: metrics.drainedRps > 0 };
        }
        if (edge.id === 'e-router-dlq') {
          return { ...edge, animated: metrics.dlqSize > 0 };
        }
        return edge;
      })
    );
  }, [
    metrics.incomingRps,
    metrics.acceptedRps,
    metrics.drainedRps,
    metrics.p50LatencyMs,
    metrics.bufferDepth,
    metrics.bufferUtilizationPct,
    metrics.dlqSize,
    workers,
    trafficActive,
    routingStrategy,
    setNodes,
    setEdges,
  ]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-[240px] bg-[#070a10]/70 border border-white/10 rounded-xl overflow-hidden"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" gap={24} size={1} />
      </ReactFlow>
    </div>
  );
};

export const DagPipeline: React.FC<DagPipelineProps> = (props) => {
  return (
    <section className="hidden lg:block glass-card rounded-2xl p-6">
      <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
        <h2 className="text-sm font-bold tracking-wider uppercase text-white">System Flow DAG</h2>
        <div className="flex items-center gap-4 text-xs text-[#94a3b8]">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#00f0ff]" /> Ingress
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#a855f7]" /> Buffer
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#10b981]" /> Healthy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#f43f5e]" /> DLQ
          </span>
        </div>
      </div>

      <ReactFlowProvider>
        <DagFlowInner {...props} />
      </ReactFlowProvider>
    </section>
  );
};
