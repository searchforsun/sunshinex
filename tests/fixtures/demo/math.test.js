// 注意：断言故意错误（add(1,2) 实际为 3）——本 fixture 供 Loop 修正环/流水线演示「检测失败→修正→复检」全流程；探针每次运行前会自动重置本文件，勿把演示后的修正态提交入库
const assert = require('node:assert');
const { add } = require('./math');
assert.equal(add(1, 2), 4);
