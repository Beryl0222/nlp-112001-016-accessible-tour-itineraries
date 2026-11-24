# 研学团可达性咨询的行程解释

研学接待文本采用 UTF-8 编码，人物、单位和记录均为合成内容。系统使用 Node.js 22、原生 ESM 与 `node:test`，无第三方运行时依赖。

| 资料 | 字段 |
| --- | --- |
| `资料/需求.json` | `id`、`group`、`locale`、`text` |
| `资料/资源.json` | `id`、`type`、`from`、`to`、`slot`、`text` |
| `资料/接待回复.json` | `id`、`source`、`received`、`text` |

每份资料是 JSON 数组。记录中的字段值按来源原样保留为字符串，逗号和顿号可以属于字段内容。资料中可能有转述、不同的拼写以及较晚录入的更正。数字及日期在这些文件中沿用各资料自身的含义；原文位置以记录编号及文本范围定位。

## 安装与检查

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm test
npm run materials
```

常用命令：

```sh
npm run report                         # 评估所有团组
node cli.js report --group 低年级同行组 --json
node cli.js parents --group 低年级同行组
node cli.js brief --group 低年级同行组
node cli.js ask --group 低年级同行组 --question "s3 轮椅"
npm run scenario                       # 演示接驳澄清后的影响传播
npm start                              # http://127.0.0.1:3000
```

`readMaterials` 只读取资料，不解析其中的正文含义。

## 核心模型

- `interpret.js`：识别粤语书面语、中文书面表达和英文近义说法，例如：
  - `摺得埋` / `foldable`
  - `除雨天外` / `except when it rains`
  - `须提前安排` / `advance arrangement`
  - `视轮椅宽度而定` / `depending on wheelchair width`
  - 同行/不可分离、短距离步行、扶手台阶、升降机偏好、活动时间窗。
- 每条判断都带 `recordId`、字符范围 `range: [start, end)`、原文 `quote`、整句 `sentence` 和 `locator`（如 `r1#text[0:4]`）。
- `analysis.js`：合并同团需求、生成轮椅画像和同行闭包，并把接待回复链接到对应路段/场次。
- `planner.js`：由 `from`、`to`、`slot` 建立相邻路段，检查时刻、步行/台阶、轮椅、接驳、容量、时间窗、天气条件和场馆接待确认。
- `ledger.js`：保存预订单与判断依据，处理更正、部分同行关系变化、影响范围、返程独立判断和新团确认隔离。
- `brief.js`：生成导游当前说明和家长解释；所有结论可回到记录编号与原文范围。
- `scheduler.js`：不同同行组可错开场次；同一同行闭包必须共享交通段和场次。
- `app.js` / `server.js`：无依赖 HTTP API 与简易中文页面。

## 状态约定

每条路段或路线返回：

- `committable` / `可承诺`：相邻路段可连接、同行分组不被拆开、硬性需求有具体正面证据、场馆接待已确认。
- `needs_confirmation` / `尚不确定·待确认`：存在未核实的硬性事项或条件；宣传文案不能充当确认。
- `unavailable` / `不可承诺`：已有明确反证、时间冲突、连接断裂或分组被拆开。

对象同时提供 `status`、`statusCode`、`decision`、`canPromise`、`committable` 等别名字段。

## 当前样本的结论

### 低年级同行组

1. `s1 → s2`（北门／小展厅，13:00–13:25）
   - 台阶有扶手，符合可短距离步行且台阶需扶手的要求；`s2` 明确接受两部轮椅，`v3` 确认十三点二十五分可两组同听。
   - 但 `s1` 未说明轮椅如何越过三阶，扶手不等于轮椅通道；且原文为「雨天停行」。因此只能列为**待确认方案**，不能无条件承诺。
2. `s3 → s4`（西门接驳／大展厅，13:35–14:15）
   - `v2` 已澄清「小巴可载轮椅」仅指可折叠型，无法载运该团那部不能折叠的轮椅，故完整团组使用 `s3` 为**不可承诺**。
   - 团方可缩小为一部可折叠轮椅，或另派符合轮椅宽度的无障碍车辆；`s4` 的整团接待与 `v1` 的十四点十五分席位确认仍可作为有效依据。
3. `s5 → s1 → s2`
   - `s5` 13:05 出发、十分钟后到北门，即约 13:15；无法接上 13:00 的 `s1`。系统会标为时间冲突，而不是把两段误判为可连接。
   - 改用北门入口直接走 `s1 → s2` 才连得上后续讲解。

### 家长观察组

英文需求说明短距离步行可以、升降机只是偏好、有扶手台阶也可以。天气确认良好时，`s1 → s2` 可承诺，并明确记录舍弃了升降机偏好。

## 程序化用法

```js
import { readMaterials } from './materials.js';
import { createService } from './api.js';

const service = createService(await readMaterials());
const plan = service.plan({ group: '低年级同行组' });
const brief = service.brief('低年级同行组');

const booking = service.book({
  id: 'B1',
  tourId: 'T1',
  group: '低年级同行组',
  segmentIds: ['s3', 's4'],
  sessionIds: ['s4']
});

const correction = {
  id: 'v2',
  source: '接驳方',
  received: '12:50',
  text: '小巴原说明仅指可折叠轮椅，无法载不能折叠的那部。'
};
const impact = service.applyCorrection(correction);
// impact.needsReconfirmation => ['s3']
// impact.stillValid => ['s4']
```

部分成员的同行约定改变时，使用 `companionChangeImpact` 或 `service.changeCompanions`。传播只覆盖发生变化的同行闭包及其交通段/场次预约；无关团组和场次保持不变。返程只有在原文明确写「同去程／same conditions」等适用范围时才可沿用去程判断，否则独立列为待确认。

旧预约确认的 `reusableByNewTour` 为 `false`；`copyForNewTour` 会复制路线草稿，但清空旧确认并要求新团重新确认所有预约事项。

## HTTP

```sh
npm start
curl http://127.0.0.1:3000/api/state
curl 'http://127.0.0.1:3000/api/brief?group=%E4%BD%8E%E5%B9%B4%E7%BA%A7%E5%90%8C%E8%A1%8C%E7%BB%84'
```

`POST /api/replies` 可提交新的接待/接驳更正，返回受影响路段、原判断依据、须重约项目和仍有效安排。
