import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProvidersSpec } from './providers';

/** providers supportsImages 两级解析（contextWindow/reasoningEffort 同构）：条目级 > 源级缺省；
 *  非布尔告警忽略、模型保留；缺省 undefined = 未声明按支持（乐观缺省） */

test('parseProvidersSpec：supportsImages 源级缺省 + 条目级覆盖，两级优先级条目>源', () => {
  const r = parseProvidersSpec(
    [
      {
        name: 'src-a',
        baseUrl: 'https://a.example/v1',
        supportsImages: false,
        models: [{ model: 'm1' }, { model: 'm2', supportsImages: true }, 'm3'],
      },
      {
        name: 'src-b',
        baseUrl: 'https://b.example/v1',
        models: [{ model: 'v1', supportsImages: false }],
      },
    ],
    'test',
  );
  assert.deepEqual(r.warnings, []);
  const byId = new Map(r.choices.map((c) => [c.id, c]));
  assert.equal(byId.get('src-a/m1')!.supportsImages, false, '源级缺省下传');
  assert.equal(byId.get('src-a/m2')!.supportsImages, true, '条目级覆盖源级');
  assert.equal(byId.get('src-a/m3')!.supportsImages, false, '字符串形态条目吃源级缺省');
  assert.equal(byId.get('src-b/v1')!.supportsImages, false, '无源级声明时条目级独立生效');
});

test('parseProvidersSpec：supportsImages 非布尔告警忽略（模型保留、值不落）', () => {
  const r = parseProvidersSpec(
    [
      {
        name: 'src',
        baseUrl: 'https://s.example/v1',
        supportsImages: 'yes',
        models: [{ model: 'm', supportsImages: 1 }],
      },
    ],
    'test',
  );
  assert.equal(r.choices.length, 1, '告警不弃模型');
  assert.equal(r.choices[0]!.supportsImages, undefined);
  assert.equal(r.warnings.length, 2, '源级与条目级各一条告警');
});

test('parseProvidersSpec：未声明 supportsImages → undefined（乐观缺省，GUI/适配器按支持放行）', () => {
  const r = parseProvidersSpec([{ name: 'p', baseUrl: 'https://p.example/v1', models: ['m'] }], 'test');
  assert.equal(r.choices[0]!.supportsImages, undefined);
});
