# 文件栏导航改造设计（IDEA 风格文件跳转）

> 日期: 2026-10-26
> 状态: 待评审（未开工）
> 分支(拟): `feat/navigation-bar`
> 影响面: client 核心包、editor 懒加载分块、host 侧新增 3 条只读路由

## 1. 背景与目标

用户诉求（原文）：当前右侧栏只能"打开一个文件看"，缺少 IDEA 那样在文件之间来回跳的能力，读代码效率低。

目标（按阅读代码时的实际动作定义）：

- 在**编辑器头部条**上提供 IDEA 式导航：前进/后退、最近位置、路径面包屑、跳转到定义、快速打开文件、当前文件大纲。
- 所有新能力**语言无关**：任何文本文件至少可用基础导航，语法能力强的语言享受更高精度（见 §5）。
- 不破坏既有交互：路径输入框、保存、预览/编辑切换、文件树、拖拽分屏全部保留。

非目标：不做补全、不做重构、不实现完整 LSP、不新增 tab 类型、不改 DSH 源码（仅通过插件自身入口改造）。

## 2. 现状（已核对 0.28.0 源码）

- 头部条 = `src/client/EditorHost.tsx:585` 起的 `div.editorHeader`：`EditorPathInput`（586）＋预览/编辑切换＋脏标记＋保存＋刷新＋文件树开关，单行 flex。
- 插件自己的 `TabBar` 只用于底部工作台（`src/client/split-pane.tsx:205`），右侧栏是 DSH 原生 tab，浏览器窗口里可见的"文件 bar"就是上面这个头部条。
- 行落地是**一次性**的：`EditorHost.tsx:155` 的 `spentLine`（键 `${path}#${line}`）＋ `TextEditor.tsx:441` 的 `landedAtRef`，同一文件同一行第二次跳不会生效 → 做导航前必须改成"按意图计数"。
- `service.ts:747 openFile(scope, path, title?)` **不带行号**；`service.ts:701 openTab` 支持 `line`，`service.ts:739 updateTab` 支持 `meta`。
- 编辑器正文拿得到整个 `tab` 对象（`src/client/builtins/tabs.tsx:100`），`tab.line` / `tab.meta` 是无侵入注入通道。
- 仓库内不存在面包屑、quick-open、符号大纲实现；可复用件：`AnchoredPopover.tsx`（视口收敛 + Esc 捕获）、`Menu.tsx`、`FloatingWindow.tsx`、`path-line.ts`（`LineSpec`）、`paths.ts`、`fs-search.ts`、`search-engines.ts`（rg/fd 探测）、`use-dir-watch.ts`。
- 快捷键现状（README）：`Mod-S` 保存、`Mod-F` 查找、`Mod-G`/`Shift-Mod-G` 上下一个、`Mod-D` 选中下一个、`Ctrl-Enter` 提交；**没有任何导航类键位**。

## 3. 功能映射（IDEA → 本插件）

| 能力 | IDEA 键位 | 落点 | 阶段 |
| --- | --- | --- | --- |
| 前进 / 后退 | `Ctrl+Alt+←/→` | 头部条 `◀ ▶`、鼠标侧键 | P1 |
| 最近位置 | `Ctrl+Shift+E` | `◀` 旁历史下拉 | P1 |
| 路径面包屑 + 同级跳转 | Navigation Bar | 头部条默认态 | P1 |
| 跳转到定义 | `Ctrl+Click` / `F12` | 编辑器内 | P1 |
| 侧边分屏打开 | `Alt+Click` | 复用 `openFileSide` | P1 |
| 当前文件符号 | `Ctrl+F12` | 符号面包屑 + 浮层/大纲面板 | P2 |
| 快速打开文件 | `Ctrl+Shift+N` | `Ctrl+P` 快速面板 | P2 |
| 跳转到行 | `Ctrl+G` | 复用 CodeMirror gotoLine | P2 |
| 跳转 import 模块 | `Ctrl+Click` | 按语言解析表 | P2 |
| 查找用法 | `Alt+F7` | 结果列表逐条跳转 | P3 |
| 预览定义 | `Ctrl+Shift+I` | AnchoredPopover 片段 | P3 |
| 相关文件 / 测试文件 | `Ctrl+Shift+T` | `⋯` 菜单 | P3 |

## 4. 交互设计

### 4.1 头部条布局

```
[◀][▶]  src › client › EditorHost.tsx   ⚡ EditorHost › openFile   [⋯][保存][刷新][树]
 └导航    └──── 面包屑（可点/可折叠） ───┘   └─ 光标所在符号 ─┘
```

- 面包屑默认取代路径输入框；点击空白处或 `Ctrl+L` 切回 `EditorPathInput`（保留粘贴 `a/b.ts:131` 的习惯），`Esc` 回面包屑。
- 目录段点击弹出该目录条目（目录在前、文件在后、带图标）；文件段点击打开"本文件符号"列表。
- 窄宽度：只保留末尾 3 段，前缀变 `…` 菜单；`< 380px` 隐藏符号面包屑（收进 `⋯`）。
- `⋯` 菜单：跳转到行 / 最近位置 / 大纲 / 相关文件 / 在侧边打开 / 在文件管理器中显示 / 复制路径。

### 4.2 三种"打开"语义

| 操作 | 行为 |
| --- | --- |
| 单击 / `Ctrl+Click` / `F12` | 当前栏内跳转：复用同 path tab，移动光标并记录历史 |
| `Alt+Click` | 向右分屏（`openFileSide`） |
| 面板内 `Shift+Enter` | 新标签页（`openFileNewTab`） |

同一文件内跳转必须走"重新落地序列"，历史中同文件 1s 内合并为一条。

### 4.3 快速面板（Quick Pick）

一个面板三种模式：文件（`Ctrl+P`）、符号（`Ctrl+Alt+O`）、最近位置（`Ctrl+Shift+E`）。

- 浮层锚定在右侧栏面板内，`z-index` 高于编辑器但不被 `overflow` 裁切 → 复用 `AnchoredPopover` 的 portal + 视口收敛。
- 宽 `min(面板宽 - 16, 520)`，最大高 56vh；`↑↓` 选择、`Enter` 跳转、`Esc` 关闭、`Tab` 切模式。
- 行内容：图标 + 文件名（fuzzy 高亮）+ 右侧灰字相对路径；符号模式追加 kind 徽标与所属作用域。
- 底部状态行：`18/12431 文件 · rg` / `未找到 · 已索引 0`，让用户看到索引状态。

### 4.4 结构（大纲）面板

右侧可停靠的符号树（复用 `editorTreeDock` 的拖拽分栏样式）：点击跳转、光标移动自动高亮当前符号、顶部过滤框。`Ctrl+F12` 打开同一数据的浮层版本。两者共享 `outline` 数据源。

### 4.5 快捷键

| 键位 | 动作 | 备注 |
| --- | --- | --- |
| `Ctrl+Alt+←/→` | 后退 / 前进 | 避开浏览器 `Alt+←` |
| `Ctrl+P` | 快速打开文件 | `preventDefault` 可拦截打印 |
| `Ctrl+Alt+O` | 当前文件符号 | 不用 `Ctrl+Shift+O`（Chromium 书签管理器） |
| `Ctrl+Shift+E` | 最近位置 | 与 IDEA 一致 |
| `F12` | 跳转到定义 | DevTools 可能抢占，见 §9 |
| `Alt+F7` | 查找用法 | 编辑器内 `preventDefault` |
| `Ctrl+Click` / `Alt+Click` | 跳转 / 侧边打开 | 无需键位声明 |
| `Ctrl+L` | 面包屑 ↔ 路径输入框 | 浏览器地址栏习惯，仅编辑器内生效 |

登记点：`use-nav-shortcuts.ts` 只挂在编辑器容器上（捕获阶段），因此不会和会话输入框抢键位。

## 5. 语言能力分档（新增章节）

### 5.1 分档依据

`src/client/lang.ts` 把 54 个扩展名映射到两类实现：

- **Tier A｜lezer 语法树**（`@codemirror/lang-*`）：`js/mjs/cjs、jsx、ts/mts/cts、tsx、python、java、c/cpp、rust、go、php、css/scss/sass/less/stylus、html、vue、xml、yaml、json/jsonl、markdown、sql`。
- **Tier B｜StreamLanguage 词法流**：`csharp、kotlin、swift、ruby、lua、perl、r、dart、scala、groovy、powershell、proto、cmake、pug、tcl、haskell、clojure、erlang、julia、pascal、vb、vhdl、tex、toml、nginx、dockerfile、properties、shell、diff、objc++`。
- **Tier C｜纯文本**：未映射扩展名（如 `.v`、`.m`）或无扩展名。

要点：StreamLanguage 同样产生一棵 token 树（节点名是 `keyword`、`variableName`、`className` 这类），因此**取词、区分关键字、Ctrl+Click 下划线装饰在 A/B 两档共用同一套代码**；差距只在"声明结构"。

### 5.2 能力矩阵

| 能力 | Tier A | Tier B | Tier C |
| --- | --- | --- | --- |
| 导航历史 / 后退前进 | ✅ | ✅ | ✅ |
| 面包屑 + 同级跳转 | ✅ | ✅ | ✅ |
| 快速打开 / 跳转到行 / 最近位置 | ✅ | ✅ | ✅ |
| Ctrl+Click 取词 + 下划线 | ✅ 语法树 | ✅ token 树 | ⚠️ 正则取词 |
| 跳转到定义 | ✅ 准确率高 | ✅ 文本检索可用 | ✅ 文本检索可用 |
| 当前文件大纲 | ✅ 精确到类/方法/字段 | ⚠️ 正则兜底，层级可能失真 | ⚠️ 正则兜底 |
| 跳转 import 模块 | ✅ 按语言解析表 | ⚠️ 部分 | ❌ 退化为同名声明搜索 |

### 5.3 声明规则表（host `symbols.ts` 与 chunk `outline.ts` 共用一份数据）

```ts
type SymbolKind = 'class' | 'interface' | 'enum' | 'type' | 'function' | 'method' | 'field' | 'module' | 'variable'

interface LanguageRule {
  /** 按优先级排列；捕获组 1 = 名字 */
  decl: RegExp[]
  /** 命中行若以这些开头，判为调用/控制流，丢弃 */
  deny?: RegExp
  /** Tier A 的 lezer 节点名 → 符号种类 */
  nodeKinds?: Record<string, SymbolKind>
  /** P2：import 语句匹配 + 解析器 id */
  import?: { match: RegExp; resolve: 'relative-js' | 'python' | 'go' | 'java' | 'rust' | 'php' | 'shell' }
}
```

| 语言族 | 扩展名 | 声明正则（节选） | 导入解析 |
| --- | --- | --- | --- |
| JS/TS/JSX/TSX | js jsx ts tsx mjs cjs mts cts | `(?:^|\s)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|enum|type|namespace)\s+([A-Za-z_$][\w$]*)`；`(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)`；`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\|[A-Za-z_$][\w$]*)\s*=>` | relative + tsconfig paths |
| Java | java | `(?:^|\s)(?:@\w+\s+)*(?:class|interface|enum|record|@interface)\s+(\w+)`；`^\s*(?:(?:public\|protected\|private\|static\|final\|abstract\|synchronized\|native\|default\|strictfp)\s+)+[\w<>\[\],.?\s]+\s+(\w+)\s*\(` | `package` → 源码根目录 |
| C#/Kotlin/Scala/Groovy | cs kt kts scala sc groovy | `\b(class\|interface\|enum\|record\|object\|struct)\s+(\w+)`；`\bfun\s+(\w+)`；`\bdef\s+(\w+)`；`(?:public\|private\|protected\|internal)?\s*(?:static\|override\|virtual\|final\|abstract\|synchronized)?\s*\w[\w<>\[\],.?]*\s+(\w+)\s*\(` | 同名类文件 |
| Python | py pyw | `^\s*(?:async\s+)?def\s+(\w+)`；`^\s*class\s+(\w+)` | 点号 → 目录 + `__init__.py` |
| Go | go | `^func\s+(?:\([^)]*\)\s*)?(\w+)`；`^type\s+(\w+)`；`^(?:var\|const)\s+(\w+)` | 包目录 |
| Rust | rs | `^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)`；`^\s*(?:pub\s+)?(?:struct\|enum\|trait\|type\|mod\|const\|static\|union)\s+(\w+)` | `crate::` 映射 |
| C/C++ | c h cc cpp cxx hpp hh hxx | `^\s*(?:template\s*<[^>]*>\s*)?(?:class\|struct\|union\|enum)\s+(\w+)`；`^\s*#\s*define\s+(\w+)`；`^\s*[\w:<>,*&\s]+\s+(\w+)\s*\([^;]*\)\s*(?:const)?\s*\{?\s*$` | `#include` 相对路径 |
| PHP | php | `\b(?:class\|interface\|trait\|enum)\s+(\w+)`；`\bfunction\s+(\w+)` | `use` / `require` |
| Ruby | rb | `^\s*def\s+(?:self\.)?(\w+)`；`^\s*(?:class\|module)\s+(\w+)` | `require_relative` |
| Shell | sh bash zsh | `^\s*(?:function\s+)?(\w+)\s*\(\)\s*\{` | `source` 相对路径 |
| SQL | sql | `\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE\|VIEW\|FUNCTION\|PROCEDURE\|INDEX)\s+([\w."]+)` | — |
| 其余（B/C 档） | 全部剩余 | 通用 `\b(class\|interface\|enum\|function\|def\|func\|fn\|type\|struct\|object)\s+(\w+)` | 无 → 同名声明搜索 |

方法形态正则的 `deny`：`^\s*(?:return|if|else|for|while|switch|case|catch|new|throw|await|yield|elif|elseif|when)\b`。

### 5.4 Tier A 大纲节点映射（lezer node → SymbolKind）

| 语言 | 节点名 |
| --- | --- |
| JS/TS | `ClassDeclaration` `FunctionDeclaration` `MethodDeclaration` `VariableDeclaration`（含箭头）`InterfaceDeclaration` `TypeDeclaration` `EnumDeclaration` `PropertyDeclaration` |
| Java | `ClassDeclaration` `InterfaceDeclaration` `EnumDeclaration` `RecordDeclaration` `MethodDeclaration` `ConstructorDeclaration` `FieldDeclaration` |
| Python | `ClassDefinition` `FunctionDefinition` |
| Go | `FunctionDeclaration` `MethodDeclaration` `TypeDeclaration` `VarDeclaration` `ConstDeclaration` |
| Rust | `FunctionItem` `StructItem` `EnumItem` `TraitItem` `ImplItem` `TypeItem` `ModItem` `ConstItem` `StaticItem` `MacroDefinition` |
| C/C++ | `ClassSpecifier` `StructSpecifier` `EnumSpecifier` `FunctionDefinition` |
| PHP | `ClassDeclaration` `InterfaceDeclaration` `TraitDeclaration` `FunctionDefinition` |
| Markdown / JSON / YAML | 标题 / 顶层键（顺带的免费收益） |

### 5.5 降级与提示

- 大纲面板标题旁标注来源：`语法树` / `正则`（Tier B/C），避免用户误判精度。
- `Ctrl+Click` 无候选 → 状态栏 `未找到定义`，不弹错误框、不移动光标。
- 候选 > 1 且分数接近 → 弹候选列表（带命中原行），不直接跳。
- 超大文件（`largeFile` 分页模式）关闭大纲与定义跳转，只保留基础导航。

## 6. 技术方案

### 6.1 模块与数据流

```
EditorHost (client core)
 ├─ nav-history.ts       导航栈 + localStorage 持久化
 ├─ breadcrumbs.tsx      路径段 / 同级菜单 / 符号面包屑
 ├─ landing.ts           {line, column, seq} 落地协议（修一次性 bug）
 ├─ QuickPick.tsx        通用 fuzzy 列表
 ├─ nav-palette.tsx      三模式面板
 └─ use-nav-shortcuts.ts 编辑器容器级快捷键

TextEditor (editor chunk)
 ├─ outline.ts           lezer 提取 / 正则兜底（依赖 CodeMirror，禁止被 core import）
 ├─ ctrl-click.ts        token 命中、下划线装饰
 └─ 通过 onToolbarState 上报 {symbolPath, line, column}（150ms 防抖）

host
 ├─ symbols.ts           声明检索 + 排序 + TTL/LRU
 ├─ file-index.ts        rg --files / walker 索引 + fuzzy 匹配
 └─ index.ts             新增 3 条只读路由
```

chunk 边界是硬约束：`outline.ts` 留在 editor chunk，core 只消费上报的字符串数组，否则 CodeMirror 会被打进 `client.js`（`tests/chunk-artifact.spec.ts` 守着）。

### 6.2 导航历史

```ts
interface NavLocation { path: string; line: number; column: number; ts: number }

interface NavHistory {
  record(loc: Omit<NavLocation, 'ts'>): void   // 截断 forward；同文件 1s 内合并；上限 60
  back(): NavLocation | null
  forward(): NavLocation | null
  recent(limit?: number): NavLocation[]
  canBack(): boolean
  canForward(): boolean
  onChange(cb: () => void): () => void
}
```

- 键：`dsh-sidebar:nav:v1:<sessionId>`（对齐 `state.ts` 的前缀风格），只存 `path/line/column/ts`，**不进** `SidebarState`，避免污染既有持久化 schema 与 `sanitizePersistedTab`。
- 记录点：tab 激活、带行打开、跳转定义、面板选择、面包屑点击；**不**记录纯光标移动（否则后退退化成撤销）。
- 后退到未打开的 tab：`service.openTab({ type: 'editor', path, line })`；已打开：`activateTab` + 发落地序列。

### 6.3 落地协议（修一次性 bug）

```ts
interface Landing { line: number; column?: number; seq: number }
```

- `EditorHost` 对每次导航意图递增 `seq`，把 `landing` 传给 viewer；`TextEditor` 的 effect 依赖 `seq` 而非 `path#line`。
- host 给的 `tab.line` 映射成内部 `seq`（line 变化时 seq+1），保持"地址式打开"语义；`spentLine` 仅用于抑制 keepMounted 重放。

### 6.4 定义检索与排序（host `symbols.definition`）

1. 客户端取词：editing chunk 内用 `syntaxTree` + `resolveInner` 拿 token；失败回退 `/[A-Za-z_$][\w$]*/`。只传 `{ path, line, column, word, ext }`。
2. host 用 `rg --json -n --max-count 8` 在 root 下按 §5.3 的声明正则检索（`rg` 缺失时降级为"当前文件 + 同目录"的 JS 扫描，状态行标注 `已降级`）。
3. 打分：同文件 +50；当前文件 import 的模块 +40；同目录 +20；路径前缀更短加分；声明种类 class/interface/func > field/var；跨语言候选（node_modules、构建产物）滤掉。
4. 返回 `{ candidates: SymbolHit[], truncated }`，`SymbolHit = { path, line, column, name, kind, source }`，`source` 是命中原行（用于候选列表与预览）。

### 6.5 文件索引与模糊匹配（host `nav.find`）

- 索引：优先 `rg --files --hidden -g '!.git/**'`（尊重 `.gitignore`，大仓库收益最大），15s 超时；失败回退 `fs-search.ts` 的 walker（复用 `SKIP_DIR_NAMES` 与 `maxVisited` 预算）。按 root 缓存，TTL 120s。
- 匹配在 host 做（子序列 + 连续段加分 + 目录分隔符权重），只回传 top 50，避免两万条路径进浏览器；客户端 80ms 防抖。
- 首次打开面板才建索引；不引入第二个 fs watcher（保持 `use-dir-watch` 单源）。

### 6.6 host 路由（沿用 `src/index.ts` 的 dispatch 与 `wire.ts`）

| 路由 | 入参 | 出参 |
| --- | --- | --- |
| `symbols.definition` | `{ path, line, column, word }` | `{ candidates, truncated }` |
| `nav.find` | `{ query, limit? }` | `{ matches: { path, score }[], total, truncated }` |
| `symbols.usages` | `{ path, name, limit? }` | `{ matches: { path, line, text }[], truncated }` |

三条都走会话作用域（`sessionQuery` + `ctx.workingDirectory`），沿用现有错误封装；与 v0.23.0 起的行为一致，不做工作区围栏（OS 权限兜底）。

### 6.7 缓存与性能预算

| 项 | 策略 |
| --- | --- |
| 定义检索 | `(root, word)` TTL 60s，LRU 200 |
| 文件索引 | 按 root TTL 120s，上限 50k 条，超限截断并提示 |
| 大纲 | 按文档 version 缓存，150ms 防抖，O(n) 一次 |
| 面包屑同级 | 打开时按需 `fs.tree`，30s 缓存 |
| 键盘/悬停 | 250ms 节流；无轮询 |

## 7. 改动清单

**P1**

- 新增：`src/client/nav-history.ts`、`src/client/breadcrumbs.tsx`、`src/client/landing.ts`、`src/client/use-nav-shortcuts.ts`、`src/symbols.ts`
- 修改：`src/client/EditorHost.tsx`（头部条改造、落地序列）、`src/client/TextEditor.tsx`（landing / ctrl-click / 装饰）、`src/client/service.ts`（工具条回调扩展）、`src/client/api.ts`、`src/index.ts`、`src/client/sidebar.module.css`（仅 `--dsw-*` token）
- 测试：`tests/nav-history.spec.ts`、`tests/symbols.spec.ts`、`tests/editor-nav.spec.tsx`

**P2**

- 新增：`src/client/QuickPick.tsx`、`src/client/nav-palette.tsx`、`src/client/outline.ts`（chunk）、`src/file-index.ts`
- 修改：`TextEditor.tsx`（符号上报）、`EditorHost.tsx`（大纲面板）、`locales.ts` + `locales-ja.ts`（新增 zh 键必须同步 ja）、`prefs.ts` + `SideCardSection.tsx`（开关/键位）
- 测试：`tests/quick-pick.spec.tsx`、`tests/file-index.spec.ts`、`tests/outline.spec.ts`（含 §5.3 表驱动用例与 `tests/fixtures/lang/` 样例）

**P3**：`symbols.usages`、Peek 浮层、相关文件、可选 TS 语言服务（读工作区 `typescript`，缺失自动降级）。

## 8. 交付与验收

- 门禁：`pnpm check`（typecheck → lint → build → test → consumer-types）。
- 额外门禁：`tests/theme.spec.ts`（无硬编码颜色）、`tests/chunk-artifact.spec.ts`（chunk 体积/边界）、`tests/steady-state.spec.tsx`（无双轮询）。
- 手工验收：Java 类/方法互跳、TS 跨文件互跳、Python 定义跳转、Kotlin（Tier B）大纲降级提示、`.txt`（Tier C）仅基础导航、后退前进跨 tab、同一行连续跳两次、面板键盘全流程。

## 9. 风险与规避

1. 浏览器抢占键位（`F12`、`Ctrl+Shift+O`）→ 默认键位避开，设置页可改；所有快捷键都有按钮入口。
2. 大仓库索引慢 → `rg --files` + TTL，超 5 万条截断并明示。
3. 误跳（rg 假阳性）→ 候选带原行；多候选先展示不直接跳。
4. chunk 体积回流 → 新代码进 core，符号提取留 chunk。
5. 样式合规 → 只用 `--dsw-*` token（`tests/theme.spec.ts` 硬门禁）。
6. 一次性落地语义被破坏 → 保留 `spentLine` 抑制 keepMounted 重放，新增 `seq` 只负责"新意图"。

## 10. 待确认

1. 定义跳转是否接受 P1 的"rg + 打分"启发式（零依赖、偶有歧义弹候选），还是直接上工作区 TypeScript 语言服务（精确但实现量翻倍）？
2. 符号信息先做浮层（`Ctrl+F12`）还是直接做可停靠大纲面板？
3. 是否确认在 0.28.0 源码上开 `feat/navigation-bar`；本地验证走 `pnpm build && pnpm pack` 后装入当前 profile。
