import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { LiveArea, tailReplyPreview } from './LiveArea';
import { markdownRowCount } from '../markdown';

test('LiveArea：思考流滚动显示末 6 行，块高恒定不跳动', () => {
  // 短文本：不足 6 行补空行，块高恒为 6
  const short = render(<LiveArea live={{ kind: 'thinking', text: '先想一步', startedAt: 0 }} columns={80} />);
  const f1 = short.lastFrame() ?? '';
  assert.match(f1, /✻ 先想一步/, '末条增量应显示');
  short.unmount();

  // 长文本：只显示尾部窗口，头部行不出现
  const long = render(
    <LiveArea
      live={{ kind: 'thinking', text: ['一', '二', '三', '四', '五', '六', '七', '八'].join('\n'), startedAt: 0 }}
      columns={80}
    />,
  );
  const f2 = long.lastFrame() ?? '';
  assert.ok(f2.includes('✻ 三') && f2.includes('✻ 八'), '应显示末 6 行中的首尾');
  assert.ok(!f2.includes('✻ 一'), '头部行不应显示');
  assert.equal(
    (short.lastFrame() ?? '').split('\n').length,
    f2.split('\n').length,
    '块高恒定：不足 6 行补空行，短/长文本帧高一致',
  );
  long.unmount();
});

test('LiveArea：答复预览只呈现未入档尾段（committedLen 水位排除前缀）', () => {
  const { lastFrame, unmount } = render(
    <LiveArea
      live={{ kind: 'reply', text: '第一行\n第二行\n第三行', committedLen: 8, startedAt: 0 }}
      columns={80}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('第三行'), '未入档尾行应显示');
  assert.ok(!frame.includes('第一行') && !frame.includes('第二行'), '已入档行不应重复显示');
  unmount();
});

test('LiveArea：答复超长时尾部窗口渲染——帧高有界、最新行可见（2026-09-28 一致性流式裁决：全量预览帧高无界增长 + 切块塌缩即真机闪屏病根，修订 09-25 全量可见口径）', () => {
  const text = Array.from({ length: 40 }, (_, i) => `行${i + 1}`).join('\n');
  const { lastFrame, unmount } = render(
    <LiveArea live={{ kind: 'reply', text, committedLen: 0, startedAt: 0 }} columns={80} />,
  );
  const frame = lastFrame() ?? '';
  const n = frame.replace(/\n$/, '').split('\n').length;
  assert.ok(!/\b行1\b/.test(frame), '头部行滚出窗口（生成期上方内容入档后经历史区查看）');
  assert.ok(frame.includes('行40'), '最新行可见——尾部窗口跟随生成推进');
  assert.ok(n <= 30, `帧高有界（实际 ${n} 行应 ≤ 30），动态区不整屏重排`);
  unmount();
});

test('LiveArea：预览窗口绑定终端行数——矮终端帧高不超视口（2026-09-28 跳到中间修复：28 行固定窗口 + 输入框/状态栏在矮终端超视口，ink 光标上移越顶即中段起渲染）', () => {
  const text = Array.from({ length: 40 }, (_, i) => `行${i + 1}`).join('\n');
  const { lastFrame, unmount } = render(
    <LiveArea live={{ kind: 'reply', text, committedLen: 0, startedAt: 0 }} columns={80} rows={14} />,
  );
  const frame = lastFrame() ?? '';
  const n = frame.replace(/\n$/, '').split('\n').length;
  assert.ok(n <= 8, `帧高有界（实际 ${n} 行应 ≤ min(28, rows−6)=8），预留输入框/状态栏/活动行`);
  assert.ok(frame.includes('行40'), '最新行仍可见');
  unmount();
});

test('LiveArea：表格行进入预览区即实时渲染（框线成形，非源码滚动）', () => {
  const table = ['| 模块 | 结论 |', '| --- | --- |', '| 渲染层 | 实时成形 |', '| 切块层 | 整表放行 |'].join('\n');
  const { lastFrame, unmount } = render(
    <LiveArea live={{ kind: 'reply', text: table, committedLen: 0, startedAt: 0 }} columns={80} />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /[─╭╰]/, '表格应以框线形态实时渲染');
  assert.ok(!frame.includes('| 模块 |'), '不应以源码竖线形态滚动');
  unmount();
});

test('LiveArea：预览统一 Markdown 渲染——粗体/列表生成期间即成形（无源码星号与短横）', () => {
  const md = '结论如下：\n**可改进项:**\n- Checkstyle 纳入 CI 门禁\n- 逻辑删除依赖人工遵守';
  const { lastFrame, unmount } = render(
    <LiveArea live={{ kind: 'reply', text: md, committedLen: 0, startedAt: 0 }} columns={80} />,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('可改进项') && frame.includes('Checkstyle'), '粗体与列表内容应显示');
  assert.ok(!frame.includes('**'), '粗体标记不得以源码星号形态出现');
  unmount();
});

test('LiveArea：长表格生成中尾部窗口渲染（框线实时成形，超预算整表滚出、尾部行恒可见）', () => {
  const mk = (n: number) => ['| 模块名 | 端口 | 所属域 |', '| --- | --- | --- |'].concat(Array.from({ length: n }, (_, i) => `| 服务${i} | 930${i} | 域${i} |`)).join('\n');
  // 未超渲染预算：整表实时可见（2026-09-30 渲染行数口径：表格渲染行数 = 2r+3，11 行表 = 25 行落进
  // budget 26；旧 mk(12) 实为 27 渲染行超预算，靠溢出整表直出——正是「正文输出跳到中间」病根形态）
  const r1 = render(<LiveArea live={{ kind: 'reply', text: mk(11), committedLen: 0, startedAt: 0 }} columns={80} />);
  const f1 = r1.lastFrame() ?? '';
  assert.match(f1, /[─╭╰]/, '表格应以框线形态实时渲染');
  assert.match(f1, /模块名/, '表头应可见');
  assert.ok(f1.includes('服务0') && f1.includes('服务10'), '预算内整表可见');
  assert.ok(!f1.includes('generating') && !f1.includes('生成中'), '生成期计数/溢出提示行保持删除');
  r1.unmount();
  // 超预算：帧高有界、尾部最新行恒可见（长表格不再把动态区撑到整屏重排）
  const r2 = render(<LiveArea live={{ kind: 'reply', text: mk(40), committedLen: 0, startedAt: 0 }} columns={80} />);
  const f2 = r2.lastFrame() ?? '';
  const n = f2.replace(/\n$/, '').split('\n').length;
  assert.ok(f2.includes('服务39'), '尾部最新行恒可见（逐行成形）');
  assert.ok(!/\b服务0\b/.test(f2), '表头/首行滚出窗口');
  assert.ok(n <= 34, `帧高有界（实际 ${n} 行应 ≤ 34），表格生成期不整屏重排`);
  r2.unmount();
});

test('tailReplyPreview：渲染行数口径收敛——块间空行与表格框线计入预算（2026-09-30 正文输出跳到中间总根修复：旧口径按原始行计数，多块正文渲染行数系统性高于估算，动态帧撑过视口即 ink3 整屏重写）', () => {
  const mkTable = (n: number) => ['| 模块名 | 端口 |', '| --- | --- |'].concat(Array.from({ length: n }, (_, i) => `| 服务${i} | 930${i} |`)).join('\n');
  // 多块正文：段落 + 无序清单（无空行源码形态，渲染层块间补空行）+ 表格 + 收尾段
  const multiBlock = ['引言段落一行。', '- 清单一', '- 清单二', '- 清单三', mkTable(6), '收尾段落一行。'].join('\n');
  // 核心不变式：任意预算下，窗口的渲染行数（markdownRowCount 同源口径）不超 budget（单行超预算兜底除外）
  for (const maxRows of [8, 14, 28]) {
    const budget = Math.max(4, maxRows - 2);
    for (const text of [multiBlock, mkTable(40), multiBlock + '\n' + mkTable(12)]) {
      const w = tailReplyPreview(text, 80, maxRows);
      if (w.includes('\n')) {
        assert.ok(
          markdownRowCount(w, 80) <= budget,
          `maxRows=${maxRows} 渲染行数 ${markdownRowCount(w, 80)} 应 ≤ 预算 ${budget}`,
        );
      }
      assert.ok(text.endsWith(w), '窗口必须是尾部连续切片');
    }
  }
  // 表格渲染膨胀（2r+3）超预算时头部行滚出、末行恒可见
  const t = tailReplyPreview(mkTable(20), 80, 10);
  assert.ok(t.includes('服务19'), '末行恒可见');
  assert.ok(!t.includes('模块名'), '超预算表头滚出窗口');
});

test('LiveArea：pad 以包络为上限——切块瞬间包络兜高不骤缩、包络缓落后小块正文不撑空白（2026-09-30「半屏空白」终版：恒高补满 maxRows-used 时 1–2 行叙述撑 ~26 行空白；包络（App 维护：升随内容、降每帧 −3、live 清空归零）传入作 pad 上限）', () => {
  // 场景一：包络已抬到满窗（26），尾段刚被切块只剩 2 行——pad = min(8, 26−2) = 8 兜住帧高（≥10 行，非 2 行骤缩）
  const cut = render(
    <LiveArea live={{ kind: 'reply', text: '尾一行\n尾两行', committedLen: 0, startedAt: 0 }} columns={80} maxRows={28} envelope={26} />,
  );
  const h1 = (cut.lastFrame() ?? '').replace(/\n$/, '').split('\n').length;
  cut.unmount();
  assert.ok(h1 >= 9, `包络兜底：切块后帧高 ${h1} 行 ≥ 10±1（pad=min(8, 包络−用量) 兜住骤缩）`);

  // 场景二：包络已缓降到内容水平（2），小块正文 2 行——pad=0，无半屏空白
  const tiny = render(
    <LiveArea live={{ kind: 'reply', text: '起手两行\n还一行', committedLen: 0, startedAt: 0 }} columns={80} maxRows={28} envelope={2} />,
  );
  const h2 = (tiny.lastFrame() ?? '').replace(/\n$/, '').split('\n').length;
  tiny.unmount();
  assert.ok(h2 <= 4, `包络缓降后小块正文帧高 ${h2} 行 ≤4（无成片空白）`);

  // 场景三：onUsed 上报实际用量（App 包络收敛数据源）
  let reported = 0;
  const rep = render(
    <LiveArea live={{ kind: 'reply', text: '第一行\n第二行\n第三行', committedLen: 0, startedAt: 0 }} columns={80} maxRows={28} onUsed={(n) => { reported = n; }} />,
  );
  rep.unmount();
  assert.ok(reported >= 3, `onUsed 上报实际渲染行数（实测 ${reported}）`);
});
