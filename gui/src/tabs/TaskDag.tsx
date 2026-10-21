import { useCallback, useEffect, useMemo } from 'react';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import { Graph as DagreGraph, layout as dagreLayout } from '@dagrejs/dagre';
import { Bot } from 'lucide-react';
import type { BoardTask } from '../projection';
import { t } from '../i18n';
import '@xyflow/react/dist/style.css';

/**
 * 任务卡 DAG 视图(G14.2xx:mermaid 拼源渲染退役,改开源图组件 React Flow(@xyflow/react,MIT)+
 * dagre 自动布局(@dagrejs/dagre,MIT)——节点=任务状态图标+任务名+执行子代理名,交互面(平移/滚轮
 * 缩放/控制钮)组件内置,mermaid 时代的拼源/容错/lightbox 全部不再需要。
 * 节点点击语义沿 G14.213:仅「有执行子代理」的任务可点 → 上抛 onTaskOpen 跳对应子 agent 页签
 * (等待态无委派不可点);START/END 虚拟节点保留并行任务的起止形态。布局为纯函数(layoutTaskDag)
 * 可独立桩测:未知依赖边忽略(会话间补发交错防御,board-layout 同款)、环交 dagre 自身割环兜底。
 */

/** 任务节点盒尺寸(dagre 布局步进 + React Flow 免实测尺寸的既定值;CSS 同值配套) */
export const TASK_NODE_W = 224;
export const TASK_NODE_H = 58;
export const TASK_NODE_H_COMPACT = 38;
/** 起止虚拟节点尺寸 */
const TERMINAL_W = 84;
const TERMINAL_H = 28;
const START_ID = '__start';
const END_ID = '__end';

export interface TaskNodeData extends Record<string, unknown> {
  id: string;
  title: string;
  status: BoardTask['status'];
  gated: boolean;
  /** 执行子代理显示名(空串=未派发:不显行、不可点) */
  agent: string;
  clickable: boolean;
}

interface TerminalNodeData extends Record<string, unknown> {
  label: string;
}

export interface TaskDagProps {
  readonly tasks: readonly BoardTask[];
  /** taskId → 执行子代理显示名(未派发回空串);布局(有无代理行)与可点判定共用同一单点 */
  readonly agentOf: (taskId: string) => string;
  /** 任务节点点击上抛(仅 agentOf 命中的节点会触发) */
  readonly onTaskOpen?: (taskId: string) => void;
}

/** 任务图 → { nodes, edges }(纯函数):dagre LR 分层布局,START→根任务/汇点→END 补起止;
 *  布局坐标为 dagre 中心点,转 React Flow 左上角落位;width/height 显式给出(免实测,jsdom 亦可渲) */
export function layoutTaskDag(
  tasks: readonly BoardTask[],
  agentOf: (taskId: string) => string,
): { nodes: Node[]; edges: Edge[] } {
  const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const inSet = new Set(sorted.map((x) => x.id));
  const g = new DagreGraph();
  g.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 64, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  const heightOf = (task: BoardTask): number => (agentOf(task.id) !== '' ? TASK_NODE_H : TASK_NODE_H_COMPACT);
  for (const task of sorted) g.setNode(task.id, { width: TASK_NODE_W, height: heightOf(task) });
  g.setNode(START_ID, { width: TERMINAL_W, height: TERMINAL_H });
  g.setNode(END_ID, { width: TERMINAL_W, height: TERMINAL_H });
  const edges: Edge[] = [];
  const link = (from: string, to: string): void => {
    g.setEdge(from, to);
    edges.push({ id: `e-${from}-${to}`, source: from, target: to });
  };
  for (const task of sorted) {
    // 缺依赖(引用集合外任务)的边忽略——跨会话补发流交错的既定防御(board-layout 同款)
    const deps = task.dependsOn.filter((d) => inSet.has(d));
    if (deps.length === 0) link(START_ID, task.id);
    for (const d of deps) link(d, task.id);
    const hasDown = sorted.some((x) => inSet.has(x.id) && x.dependsOn.includes(task.id));
    if (!hasDown) link(task.id, END_ID);
  }
  dagreLayout(g);
  const at = (id: string, w: number, h: number): { x: number; y: number } => {
    const n = g.node(id);
    return { x: n.x - w / 2, y: n.y - h / 2 };
  };
  const terminal = (id: string, label: string): Node<TerminalNodeData, 'terminal'> => ({
    id,
    type: 'terminal',
    position: at(id, TERMINAL_W, TERMINAL_H),
    width: TERMINAL_W,
    height: TERMINAL_H,
    draggable: false,
    deletable: false,
    data: { label },
  });
  return {
    nodes: [
      terminal(START_ID, t('▶ start', '▶ 开始')),
      ...sorted.map((task) => {
        const h = heightOf(task);
        const agent = agentOf(task.id);
        return {
          id: task.id,
          type: 'task' as const,
          position: at(task.id, TASK_NODE_W, h),
          width: TASK_NODE_W,
          height: h,
          deletable: false,
          data: {
            id: task.id,
            title: task.title !== '' ? task.title : task.id,
            status: task.status,
            gated: task.gated === true,
            agent,
            clickable: agent !== '',
          },
        };
      }),
      terminal(END_ID, t('◼ end', '◼ 结束')),
    ],
    edges,
  };
}

/** 任务节点:状态图标(列表行同款 tb-status-dot)+任务名(+gated ⚠)+执行子代理行(🤖)。
 *  节点名恒单行截断——hover 显全名走全局 data-tip 单例(§13.1 规则 2 禁原生 title、规则 4 截断文本场景) */
function TaskNode({ data }: NodeProps<Node<TaskNodeData, 'task'>>): JSX.Element {
  return (
    <div
      className={`tb-dag-node task-status-${data.status}${data.clickable ? ' clickable' : ''}${data.gated ? ' gated' : ''}`}
      aria-label={`${data.id} [${data.status}] ${data.title}`}
      data-tip={data.title}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="tb-dag-node-head">
        <span className={`tb-status-dot task-status-${data.status}`} aria-hidden="true" />
        <span className="tb-dag-node-title">{data.title}</span>
        {data.gated && (
          <span className="sx-badge sx-badge-warn" role="img" aria-label="gate waiting">
            ⚠
          </span>
        )}
      </div>
      {data.agent !== '' && (
        <div className="tb-dag-node-agent">
          <Bot size={11} strokeWidth={1.75} aria-hidden="true" />
          {data.agent}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** 起止虚拟节点(START/END):弱化的虚线胶囊,纯形态不承载交互 */
function TerminalNode({ data }: NodeProps<Node<TerminalNodeData, 'terminal'>>): JSX.Element {
  return (
    <div className="tb-dag-terminal" aria-hidden="true">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {data.label}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { task: TaskNode, terminal: TerminalNode };

/** 视图适配参数单点:装载 fitView 与复位钮(Controls)共用——G14.2xx 用户实测反馈「复位不可用」
 *  的真凶:Controls 不传 fitViewOptions 时默认上限吃 ReactFlow maxZoom(1.75),小图点复位反而
 *  放大;钉同一份 padding/maxZoom 后复位=回到装载态,duration 给出可见的动画回正反馈 */
const FIT_VIEW_OPTIONS = { padding: 0.12, maxZoom: 1, duration: 300 };

function TaskDagInner({ tasks, agentOf, onTaskOpen }: TaskDagProps): JSX.Element {
  const { nodes, edges } = useMemo(() => layoutTaskDag(tasks, agentOf), [tasks, agentOf]);
  const { fitView } = useReactFlow();
  // 任务增减即回正视图(新任务可能落画面外);节点拖拽后的位置交布局重算统一
  useEffect(() => {
    const timer = setTimeout(() => void fitView(FIT_VIEW_OPTIONS), 30);
    return () => clearTimeout(timer);
  }, [fitView, nodes.length]);
  const onNodeClick = useCallback<NonNullable<Parameters<typeof ReactFlow>[0]['onNodeClick']>>(
    (_, node) => {
      if (node.type === 'task' && (node.data as TaskNodeData).clickable === true) onTaskOpen?.(node.id);
    },
    [onTaskOpen],
  );
  return (
    <ReactFlow
      className="tb-dag-reactflow"
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={onNodeClick}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.15}
      maxZoom={1.75}
      nodesConnectable={false}
      deleteKeyCode={null}
      defaultEdgeOptions={{ type: 'smoothstep', animated: true }}
      // G14.2xx 用户裁定:右下角 React Flow 水印去除(桌面内部应用,proOptions 官方开关)
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={14} size={1} />
      {/* 控制钮(+/−/复位)钉右下角(G14.2xx 用户裁定,左下角退役) */}
      <Controls position="bottom-right" showInteractive={false} fitViewOptions={FIT_VIEW_OPTIONS} />
    </ReactFlow>
  );
}

/** default 导出为 lazy() 载入面(React Flow 不进主 bundle,与 mermaid 时代的分包纪律同口径) */
export default function TaskDag(props: TaskDagProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <TaskDagInner {...props} />
    </ReactFlowProvider>
  );
}
