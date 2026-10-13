# 实时进度 · feat/mist-fabric-commercial-units

> 云端 Agent 每次推送都会更新本文件，最新一条放在最上面。本机预览跟随本分支即可看到同一份代码。
> 本文件只记录过程；正式交接仍写入 `05-migration-playbook.md`。

## 怎么和云端看到同一份内容

- 代码：本机预览跟踪 `feat/mist-fabric-commercial-units`，每次推送后约 30 秒自动更新。
- 数据：双方都使用 `seed: "demo"` 生成的“Mist 示例数据”空间。云端测试时新建的数据只存在云端沙箱，结果以本文件里的测试记录和截图为准。
- 测试：云端每轮在 Node 22 下运行 `npm run verify:mist`，数字写在下面。

---

## 2026-10-13 22:55 +08 · 开工 / 基线

- 分支从 `feat/mist-fabric-development`（`5d254d8`，PR #2）创建，不改 main、不合并、不部署。
- 云端环境：Node v22.23.3，`npm ci`、`npm --prefix server ci`、`prisma generate` 均成功。
- 基线 `verify:mist` 全部通过：前端 37 文件 567 项，后端 29 文件 385 项，类型检查无诊断，构建成功，Mist 检查 85 文件 0 error / 0 warning。与 PR #2 记录一致。

### 本批目标（Handoff 下一步第 1 项）：面料报价 → 产品 → 转单的商业单位

已定位的问题：

1. `server/src/shared/mistMarket.ts` · `market.product.fromVersion`：面料版本建档时写死 `unit:'米'`、`currency:'USD'`、`cost:'0'`，没有读取开发案里实际的目标价币种和计价单位。
2. `dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx` · 报价条目：从开发版本选来源时写死 `unit:'件'`，规格拼成 `尺码 / 面料`，面料版本也套用成衣字段。
3. 同文件 · 新建产品档案默认 `unit:'件'`；新报价空白条目默认 `unit:'件'`。
4. `market.quotation.convert`：订单行按报价行单位原样带入，这一步本身不换算；需要确认面料单位从报价到订单行保持一致，并补回归。

计划：只读来源开发案里已保存的面料单位/币种，缺失时留空并要求人工填写，不猜、不换算；成衣路径保持原行为并保留回归测试。

状态：进行中。
