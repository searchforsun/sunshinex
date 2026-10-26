/**
 * 图片附件共享面常量契约测试：数量钳制/降采样长边/JPEG 质量三常量单源在 src/images.ts，
 * serve/TUI/GUI 装载面与插件 server 生产者同规范（视觉端点友好口径）。锁值防跨面漂移。
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { IMAGE_JPEG_QUALITY, IMAGE_MAX_EDGE, MAX_IMAGES } from './images';

test('视觉规范三常量锁值（GUI 装载面与插件 server 生产者同规范）', () => {
  assert.equal(MAX_IMAGES, 8, '单条消息图片上限');
  assert.equal(IMAGE_MAX_EDGE, 1568, '降采样长边(vision 端点惯例 ≤1568px)');
  assert.equal(IMAGE_JPEG_QUALITY, 0.85, '降采样 JPEG 质量');
});
