/**
 * 改动行数统一显示(2026-11-07 用户裁定「去掉新建/删除特殊样式,直接显示 +100 -0 / +0 -100」):
 * 轮尾汇总条(RunChangesBar 头+逐文件行)与侧栏审查页(DiffTab)共用——恒显两侧、零也显示。
 * 新建(untracked,numstat 不覆盖)的增加行=内容行数 newLines;删除文件 numstat 本就是 +0 -N。
 */

export interface ChangeCountsLike {
  readonly added: number | null;
  readonly deleted: number | null;
  readonly newLines?: number;
}

export function changeCounts(c: ChangeCountsLike): { add: number; del: number } {
  return { add: c.added ?? c.newLines ?? 0, del: c.deleted ?? 0 };
}

export function ChangeStat({ add, del }: { add: number; del: number }): JSX.Element {
  return (
    <>
      <span className="sx-change-add">{`+${add}`}</span>
      <span className="sx-change-del">{`-${del}`}</span>
    </>
  );
}
