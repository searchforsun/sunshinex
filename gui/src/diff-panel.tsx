/**
 * G6 diff 并排面板（Chat 工具条 write 展开 / 后续编辑工具消费）：双列等宽 <pre>——
 * 左 old 右 new；oldStr 缺场只渲染右列（builtin write 是整文件替换写，调用面无 pre-image，
 * 只有新内容一列）。标题行 `− old / + new` 恒定（列语义锚点，单列时左标题无对应列不误导——
 * 标题是图例行而非列头）。零 diff 算法：纯并排呈现，行内差异归样式面/后续任务。
 */

export interface DiffPanelProps {
  /** 旧文本（缺场 = 只右列——新建文件/无 pre-image 面） */
  oldStr?: string;
  /** 新文本（恒在场——右列） */
  newStr: string;
}

export function DiffPanel({ oldStr, newStr }: DiffPanelProps): JSX.Element {
  return (
    <div className="diff-panel" aria-label="diff">
      <div className="diff-titles">
        <span className="diff-title-old">− old</span>
        <span className="diff-title-new">+ new</span>
      </div>
      <div className="diff-cols">
        {oldStr !== undefined && <pre className="diff-col diff-old">{oldStr}</pre>}
        <pre className="diff-col diff-new">{newStr}</pre>
      </div>
    </div>
  );
}
