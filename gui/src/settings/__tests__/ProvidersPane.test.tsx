import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProvidersPane } from '../ProvidersPane';
import type { ProvidersPaneConn } from '../ProvidersPane';
import type { Connection, ProviderEntry, SettingsKeyRow, SettingsView } from '../../connection';

/**
 * Task 26 ProvidersPane 重构桩测(提供方 ResourceCard 卡片化+op 端点写面+编辑弹窗+
 * 请求参数卡散键行退役):conn 全桩(settings/putSettings/putProviderOp 三面,不出网),
 * 用例沿 task brief——①卡片渲染含默认标记(choices[0]=默认模型)+密钥状态点+warnings;
 * ②删除调 op remove+成功重拉;③models 上移下移提交 modelMove(文件级手术+行重播种);
 * ④apiKey 提交走 setKey 且输入框清空(关弹窗)、重拉响应无键值回显;⑤新增提交 op add
 * (密钥留空零 setKey);⑥请求参数卡无「API 地址」行/模型散键 Combo 退役;⑦请求参数卡
 * 恒全局写钉测(2026-10-29 用户裁定豁免:root 恒 ''——PUT /settings 无 root 即缺省全局,
 * 断言 putSettings 首参 global/second undefined);⑧refreshTick 重拉;⑨表单校验(空名/空
 * models)拦截零落盘;⑩空清单空态;⑪工具栏单件(2026-10-29 用户裁定:页面即全局——
 * ScopeSelect/SearchBar 撤除只留新增钮;读恒省参=仅全局清单;新增/删除恒写全局 op
 * scope=global 省参 root);⑫models 行边界禁用(首行 ↑ disabled/末行 ↓ disabled,客户端
 * 拦截零 op——2026-10-29 用户裁定);⑬op 失败透出服务端 {error,hint}(connection 层组装,
 * 行内错误条呈真因非 `-> 409` 连接层格式)。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 * 注:挂载=两笔 settings 请求(内嵌 SettingsForm 表单面+卡面,均恒全局省参——页面即全局);
 * settingsCalls 断言按此计数。
 * 键行 source 钉 'global'(SettingsForm 恒全局读——daemon 无 root GET 投影即全局面,
 * 行 source=global → 写恒 global 桶)。
 */

/** putProviderOp 输入形(connection.ts 内联签名提取——桩记录类型用,McpPane.test 同款) */
type ProviderOpInputShape = Parameters<Connection['putProviderOp']>[0];

/** GET /settings providers.entries 行构造器(daemon listProviders 富化行形合法缺省——
 *  apiKeyEnv/apiKeyPresent 恒在场,Task 26 评审修补后 GUI 密钥点直读本行字段) */
const entryOf = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({
  name: 'p1',
  baseUrl: 'https://api.p1/v1',
  models: [{ model: 'm1', tier: 'large' }, { model: 'm2' }],
  apiKeyEnv: 'SUNSHINEX_API_KEY_P1',
  apiKeyPresent: true,
  ...over,
});

/** 键行构造器(SettingsKeyRow 合法缺省——SettingsForm 行仅渲染 daemon 报键面;
 *  source 钉 'global':内嵌请求参数卡恒全局读) */
const keyRow = (key: string, value: string | null): SettingsKeyRow => ({ key, value, source: 'global', envOverride: false });

/** GET /settings 应答构造器:providers 面 choices+entries+apiKeyPresent+warnings 可编程;
 *  keys 面=请求参数卡两语义键(tier/reasoningEffort,global 来源——写路径钉 global 桶) */
const viewOf = (providers: Partial<SettingsView['providers']> = {}): SettingsView => ({
  keys: [keyRow('tier', 'medium'), keyRow('reasoningEffort', null)],
  permissions: {
    merged: { deny: [], allow: [], additionalDirs: [] },
    project: { deny: [], allow: [], additionalDirs: [] },
    global: { deny: [], allow: [], additionalDirs: [] },
  },
  providers: {
    choices: [
      { id: 'p1/m1', provider: 'p1', model: 'm1', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
      { id: 'p1/m2', provider: 'p1', model: 'm2', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
      { id: 'p2/m9', provider: 'p2', model: 'm9', baseUrl: 'https://api.p2/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P2' },
    ],
    entries: [entryOf(), entryOf({ name: 'p2', baseUrl: 'https://api.p2/v1', models: [{ model: 'm9' }], apiKeyEnv: 'SUNSHINEX_API_KEY_P2', apiKeyPresent: false })],
    apiKeyPresent: { p1: true, p2: false },
    warnings: ['providers warn line'],
    ...providers,
  },
  warnings: [],
});

/** conn 桩:三面调用记录(settings 挂载=两笔消费(SettingsForm+卡面)同代答 initial,重拉答
 *  next——未给 next 重拉仍答 initial);opError 在场=putProviderOp 首调即拒(错误透出钉测) */
const connOf = (
  initial: SettingsView,
  next?: SettingsView,
  opts: { opError?: Error } = {},
): {
  conn: ProvidersPaneConn;
  settingsCalls: Array<string | undefined>;
  putSettingsCalls: Array<['project' | 'global', string | undefined, Record<string, string | number | null>]>;
  opCalls: ProviderOpInputShape[];
} => {
  const settingsCalls: Array<string | undefined> = [];
  const putSettingsCalls: Array<['project' | 'global', string | undefined, Record<string, string | number | null>]> = [];
  const opCalls: ProviderOpInputShape[] = [];
  let n = 0;
  return {
    conn: {
      settings(root?: string) {
        settingsCalls.push(root);
        const view = n < 2 || next === undefined ? initial : next;
        n += 1;
        return Promise.resolve(view);
      },
      putSettings(scope, root, updates) {
        putSettingsCalls.push([scope, root, updates]);
        return Promise.resolve();
      },
      putProviderOp(input: ProviderOpInputShape) {
        opCalls.push(input);
        return opts.opError !== undefined ? Promise.reject(opts.opError) : Promise.resolve();
      },
      memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
    },
    settingsCalls,
    putSettingsCalls,
    opCalls,
  };
};

describe('ProvidersPane(卡片化+op 写面)', () => {
  it('卡片渲染:名/baseUrl 副行/models chips(2026-11-05 用户裁定:默认标记退役)+密钥状态点+warnings;请求参数卡在', async () => {
    const { conn, settingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    expect(await screen.findByText('p1')).toBeDefined();
    expect(screen.getByText('p2')).toBeDefined();
    expect(screen.getByText('https://api.p1/v1')).toBeDefined(); // baseUrl 副行
    expect(screen.getByText('m1')).toBeDefined(); // models chips
    expect(screen.getByText('m2')).toBeDefined();
    expect(screen.getByText('m9')).toBeDefined();
    expect(screen.queryByText('Default')).toBeNull(); // 默认标记退役
    expect(document.querySelector('.sx-api-dot.present')).not.toBeNull(); // p1 密钥在场=绿点(entries 行 apiKeyPresent)
    expect(document.querySelectorAll('.sx-api-dot.missing')).toHaveLength(1); // p2 缺=灰点
    expect((document.querySelector('.sx-api-dot.missing') as HTMLElement).getAttribute('data-tip')).toBe('SUNSHINEX_API_KEY_P2'); // tip=entries 行 apiKeyEnv
    expect(screen.getByText('providers warn line')).toBeDefined(); // providers warnings 行
    // 挂载两笔,均恒全局省参(页面即全局——内嵌 SettingsForm 豁免+卡面不再随目标切换)
    await waitFor(() => expect(settingsCalls).toEqual([undefined, undefined]));
    // 请求参数卡仅 tier/effort 两 select(SettingsForm 复用);卡片标题带恒全局注明
    expect(screen.getByText('Request parameters')).toBeDefined(); // 2026-10-30 标题「(全局)」注明去除
    expect(screen.getByRole('button', { name: 'tier' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'reasoningEffort' })).toBeDefined();
  });

  it('散键行退役:无「API 地址」(API base URL)行、无模型档位散键(model/modelSmall…)Combo', async () => {
    const { conn } = connOf(viewOf({ entries: [], choices: [], apiKeyPresent: {} }));
    render(<ProvidersPane conn={conn} />);
    await screen.findByRole('button', { name: 'tier' });
    expect(screen.queryByText('API base URL')).toBeNull(); // en 标签
    expect(screen.queryByText('API 地址')).toBeNull(); // zh 标签
    expect(screen.queryByLabelText('model')).toBeNull(); // 模型散键 Combo 四行全退役
    expect(screen.queryByLabelText('modelSmall')).toBeNull();
    expect(screen.queryByLabelText('modelMedium')).toBeNull();
    expect(screen.queryByLabelText('modelLarge')).toBeNull();
    expect(screen.queryByLabelText('baseUrl')).toBeNull();
  });

  it('删除:卡 Delete 钮两段确认(2026-10-30 裁定:首击武装原地红钮,再击执行)→ putProviderOp {op:remove, scope:global(省参 root), name} + 成功重拉(页面即全局,恒写全局)', async () => {
    const { conn, opCalls, settingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete p1' })); // 首击=武装(零请求)
    expect(opCalls).toEqual([]); // 确认前零副作用
    fireEvent.click(screen.getByRole('button', { name: 'Delete p1' })); // 再击=确认执行(aria-label 两段恒定)
    await waitFor(() => expect(opCalls).toEqual([{ op: 'remove', scope: 'global', name: 'p1' }]));
    await waitFor(() => expect(settingsCalls.length).toBe(3)); // 成功重拉(挂载两笔+重拉一笔)
  });

  it('models 上移/下移:行按钮 → putProviderOp {op:modelMove, name, model, direction} + 重拉行重播种', async () => {
    const moved = viewOf({
      entries: [entryOf({ models: [{ model: 'm2' }, { model: 'm1', tier: 'large' }] })],
      choices: [
        { id: 'p1/m2', provider: 'p1', model: 'm2', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
        { id: 'p1/m1', provider: 'p1', model: 'm1', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
      ],
    });
    const { conn, opCalls } = connOf(viewOf(), moved);
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit p1' }));
    await screen.findByRole('dialog', { name: 'Edit p1' });
    fireEvent.click(screen.getByRole('button', { name: 'Move up m2' }));
    await waitFor(() =>
      expect(opCalls).toEqual([{ op: 'modelMove', scope: 'global', name: 'p1', model: 'm2', direction: 'up' }]),
    );
    // 重拉+行重播种(次答=服务端已施行的行序):m2 移首,其下移钮可用
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move down m2' })).toBeDefined());
    expect(screen.getByRole('dialog', { name: 'Edit p1' })).toBeDefined(); // 抽屉保持开启
    fireEvent.click(screen.getByRole('button', { name: 'Move down m2' }));
    await waitFor(() =>
      expect(opCalls).toEqual([
        { op: 'modelMove', scope: 'global', name: 'p1', model: 'm2', direction: 'up' },
        { op: 'modelMove', scope: 'global', name: 'p1', model: 'm2', direction: 'down' },
      ]),
    );
  });

  it('边界禁用(2026-10-29 用户裁定):首行 ↑ disabled、末行 ↓ disabled,点击零 op 落盘(客户端拦截不发请求)', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit p1' }));
    await screen.findByRole('dialog', { name: 'Edit p1' });
    // 两行 [m1, m2]:m1 首行(↑ 禁/↓ 可),m2 末行(↑ 可/↓ 禁)
    expect((screen.getByRole('button', { name: 'Move up m1' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move down m1' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Move up m2' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Move down m2' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move up m1' })); // 禁用钮点击=浏览器不派发,双保险断言
    fireEvent.click(screen.getByRole('button', { name: 'Move down m2' }));
    expect(opCalls).toEqual([]); // 零 op(不发请求)
  });

  it('moveModel 行重播种键合(T26 评审修补):本地未保存行字段编辑按模型名保留,文件外行(新增未落盘)随 fresh 丢弃+提示行言明', async () => {
    const moved = viewOf({
      entries: [entryOf({ models: [{ model: 'm2' }, { model: 'm1', tier: 'large' }] })],
      choices: [
        { id: 'p1/m2', provider: 'p1', model: 'm2', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
        { id: 'p1/m1', provider: 'p1', model: 'm1', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
      ],
    });
    const { conn, opCalls } = connOf(viewOf(), moved);
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit p1' }));
    await screen.findByRole('dialog', { name: 'Edit p1' });
    // 未保存行编辑:m2 行(第二行)contextWindow 填 12345;再 + 新增一行 mNew(文件外,未落盘)
    fireEvent.change(screen.getAllByLabelText('Context window')[1]!, { target: { value: '12345' } });
    fireEvent.click(screen.getByText('+ Add model'));
    fireEvent.change(screen.getAllByLabelText('Model name')[2]!, { target: { value: 'mNew' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move up m2' }));
    await waitFor(() =>
      expect(opCalls).toEqual([{ op: 'modelMove', scope: 'global', name: 'p1', model: 'm2', direction: 'up' }]),
    );
    // 重播种:行序=fresh [m2, m1];mNew(模型名不在文件)随 fresh 丢弃;m2 的未保存窗口编辑键合保留
    await waitFor(() => expect(screen.getAllByLabelText('Model name')).toHaveLength(2));
    expect((screen.getAllByLabelText('Model name')[0] as HTMLInputElement).value).toBe('m2');
    expect((screen.getAllByLabelText('Context window')[0] as HTMLInputElement).value).toBe('12345');
    // 提示行断言随 2cd5913「编辑弹窗两条解释段删除」一并退役(用户裁定:多余说明)
  });

  it('编辑保存+密钥:编辑态密钥框恒空(不回显)→ Save = op update(provider patch)+ setKey(键值仅入请求体);抽屉关+重拉面无键值', async () => {
    const { conn, opCalls, settingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit p1' }));
    await screen.findByRole('dialog', { name: 'Edit p1' });
    const keyInput = screen.getByLabelText('API key') as HTMLInputElement;
    expect(keyInput.value).toBe(''); // 密钥永不回显:编辑播种恒空串
    expect(keyInput.getAttribute('type')).toBe('password');
    fireEvent.change(keyInput, { target: { value: 'sk-secret-1' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        {
          op: 'update',
          scope: 'global',
          name: 'p1',
          provider: { baseUrl: 'https://api.p1/v1', models: [{ model: 'm1', tier: 'large' }, { model: 'm2' }] },
        },
        { op: 'setKey', scope: 'global', name: 'p1', apiKey: 'sk-secret-1' },
      ]),
    );
    expect(screen.queryByRole('dialog')).toBeNull(); // 提交后关抽屉(密钥输入框随之清空离场)
    await waitFor(() => expect(settingsCalls.length).toBe(3)); // 成功重拉(挂载两笔+重拉一笔)
    expect(document.body.textContent).not.toContain('sk-secret-1'); // 响应/重拉面零键值回显
  });

  it('新增:Save = op add(baseUrl+非空 models 必备;密钥留空零 setKey)+ 关抽屉重拉;恒写全局(scope=global 省参 root)', async () => {
    const { conn, opCalls, settingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add provider' }));
    await screen.findByRole('dialog', { name: 'Add provider' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'p3' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.p3/v1' } });
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'm7' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        { op: 'add', scope: 'global', name: 'p3', provider: { baseUrl: 'https://api.p3/v1', models: [{ model: 'm7' }] } },
      ]),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(settingsCalls.length).toBe(3));
  });

  it('models 行强度/档位共享 Select(2026-10-30 弹窗对齐主设置面):弹层点选 low/small → patch models 带 reasoningEffort/tier(提交形状零变化)', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add provider' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add provider' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'p3' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.p3/v1' } });
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'm7' } });
    // 强度/档位=共享 Select trigger(aria-label;单行各一,within(dialog) 消歧内嵌请求参数卡 tier/effort 小写键钮)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Effort' }));
    expect(document.querySelector('.sx-editor-modal-backdrop .sx-dd-pop')).not.toBeNull(); // 弹层在弹窗内渲染(z 修正回归保护)
    fireEvent.click(within(dialog).getByRole('option', { name: 'Low' })); // 10c96cc 起选项标签双语(渲染期 t)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tier' }));
    fireEvent.click(within(dialog).getByRole('option', { name: 'Small' }));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        { op: 'add', scope: 'global', name: 'p3', provider: { baseUrl: 'https://api.p3/v1', models: [{ model: 'm7', reasoningEffort: 'low', tier: 'small' }] } },
      ]),
    );
  });

  it('请求参数卡恒全局写钉测(2026-10-29 用户裁定豁免):putSettings(global, undefined, {tier})——语义键写路径保留且无 root(缺省全局)', async () => {
    const { conn, putSettingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    await screen.findByText('p1');
    fireEvent.click(screen.getByRole('button', { name: 'tier' }));
    fireEvent.click(screen.getByRole('option', { name: 'Large' })); // 10c96cc 起选项标签双语(渲染期 t)
    await waitFor(() => expect(putSettingsCalls).toEqual([['global', undefined, { tier: 'large' }]])); // 首参 global,root 省参
  });

  it('refreshTick 变化触发重拉(config-changed 外部改动信号)', async () => {
    const { conn, settingsCalls } = connOf(viewOf());
    const { rerender } = render(<ProvidersPane conn={conn} refreshTick={0} />);
    await screen.findByText('p1');
    expect(settingsCalls).toEqual([undefined, undefined]);
    rerender(<ProvidersPane conn={conn} refreshTick={1} />);
    await waitFor(() => expect(settingsCalls).toEqual([undefined, undefined, undefined])); // 卡面重拉(SettingsForm 不订阅 providers tick)
  });

  it('表单校验:空名/空 models 提交被拦(行内报错,零 op 落盘)', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add provider' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add provider' });
    fireEvent.click(screen.getByText('Save')); // 全空:名称校验先拦
    await waitFor(() => expect(within(dialog).getAllByRole('alert').length).toBeGreaterThan(0)); // 抽屉内行内报错(warnings 亦 role=alert,within 消歧)
    expect(opCalls).toEqual([]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'p3' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.p3/v1' } });
    fireEvent.click(screen.getByText('Save')); // models 空行:非空 models 校验拦
    await waitFor(() => expect(within(dialog).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(opCalls).toEqual([]);
  });

  it('空清单:entries 空 → 空态文案(非报错面)', async () => {
    const { conn } = connOf(viewOf({ entries: [], choices: [], apiKeyPresent: {}, warnings: [] }));
    render(<ProvidersPane conn={conn} />);
    expect(await screen.findByText('No providers configured.')).toBeDefined();
  });

  it('工具栏单件(2026-10-29 用户裁定:页面即全局):无作用域下拉(Settings scope)无搜索框(Search),只留新增钮;卡片列表无过滤面', async () => {
    const { conn } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    await screen.findByText('p1');
    const section = document.querySelector('section.sx-providers') as HTMLElement; // within 消歧(内嵌 SettingsForm 另有过滤搜索)
    expect(within(section).queryByRole('button', { name: 'Settings scope' })).toBeNull(); // ScopeSelect 撤除
    expect(within(section).queryByLabelText('Search')).toBeNull(); // SearchBar 撤除
    expect(within(section).getByRole('button', { name: '+ Add provider' })).toBeDefined(); // 工具栏唯一件
    expect(screen.getByText('p2')).toBeDefined(); // 全量呈现(无过滤)
  });

  it('op 失败透出服务端 {error,hint}(2026-10-29 用户裁定):行内错误条呈服务端真因(error+hint 原文),非 `-> 409` 连接层格式(组装在 connection 层,connection.test 钉测)', async () => {
    const { conn } = connOf(viewOf(), undefined, { opError: new Error('model m9 not found in provider p2 — check the file') });
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete p2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete p2' })); // 两段确认(再击=执行)
    // .sx-error-banner 消歧(providers warnings 行亦 role=alert)
    await waitFor(() => expect(document.querySelector('.sx-error-banner')?.textContent).toContain('model m9 not found in provider p2'));
    expect(document.querySelector('.sx-error-banner')!.textContent).not.toContain('-> 409'); // 连接层裸格式不再透出
  });
});
