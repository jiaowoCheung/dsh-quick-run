# dsh-quick-run

DSH 的会话标题栏里放一个 IDEA / VS Code 风格的运行配置小部件：选一个脚本，一键运行，实时看输出。

## 它长在哪

`conversation.session.header.utilities`（list、session 作用域）——会话标题下面那一条里，
`对话 / 轨迹` 标签和 `…` 更多视图按钮之后、右侧一排工具图标和 Header `…` 菜单之前。
这是给扩展预留的座位，不读别的插件 DOM、不改应用根节点。

小部件本身是「`▶` + 配置名 + `▾`」一个圆角的小胶囊：

- `▶` 运行当前配置；运行中变成 `■`，再点停掉整棵进程树。
- 名字 / `▾` 打开下拉：配置列表（名称 + 实际命令）、`编辑配置…`、`刷新`、`重置为自动发现`。
- 输出面板是浮层（`position: fixed`，锚在小部件右下），带状态点、耗时、停止 / 清空 / 关闭。

## 数据通路

会话日志和模型请求都不碰运行输出：

```
client.js  ──POST /dsh-quick-run/api/*──▶  index.js（host 半边，webServer 路由）
   ▲                                        │
   └────── run.poll 按字符 offset 增量 ──────┘  child_process.spawn（cwd = Session 工作目录）
```

- `config.list` / `config.save` / `config.reset`：读、写、删 `<cwd>/.dsh-quick-run.json`；
  没有文件时按 `package.json` scripts 和根目录脚本文件自动发现。
- `run.start`：同一个 Session 同一个配置正在跑就复用那一次，不重复起进程。
- `run.poll`：`{ runId, offset }` → `{ chunk, offset, state, code, signal, durationMs, truncated }`，
  前端每 350ms 拉一次，把 chunk 追加到 `<pre>` 里；服务端缓冲上限 200KB（丢头部、记 `base`），
  前端再兜一层 400KB。
- `run.stop`：Windows 用 `taskkill /pid <pid> /T /F` 杀进程树；POSIX 用 `detached` + 负 pid `SIGTERM`。
- 路由会先用 `connection.requestRejection(req)` 走 DSH 自己的鉴权和 Host/Origin 围栏（服务缺席时跳过）。

选这个方案而不是 `ctx.subprocess` / PTY：运行配置要的是「像 IDE 那样跑我指定的东西」，
不需要沙箱内的一次性命令语义（`ctx.subprocess` 还会剥掉 `DSH_*` 和疑似密钥的环境变量），
也不想和终端服务的 `isolate` 分组耦合。输出不回灌会话日志，所以不会污染上下文。

## 配置模型

```ts
type RunConfig = {
  id: string
  name: string
  command?: string            // 经 shell
  script?: string             // .ps1 / .bat / .cmd / .sh
  program?: string
  args?: string[]             // 与 program 搭配，直接 exec
  cwd?: string                // 相对会话工作目录
  env?: Record<string, string>
}
```

`normalizeConfig` 负责补 `id`（没有就按名字生成 slug、重名加后缀）、拼出 `detail`（下拉里那行等宽小字）。
`.dsh-quick-run.json` 写 `{ "configs": [...] }`，可选 `"includeDiscovered": true` 把自动发现结果并进来。

## 状态

`running → exited`（有 code）或 `stopping → stopped`；启动失败是 `failed`，
前端重新挂载时会用 `run.active` 把还在跑的 / 刚跑完的那一次捡回来。结束 10 分钟后从内存清理，
最多同时留 20 次运行。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：`webServer` 路由、配置发现/读写、进程生命周期、输出缓冲 |
| `client.js` | Client 半边：`__ModuleLoader__` 工厂，注册 header 小部件 + 下拉 + 输出/编辑浮层 |
| `cordis.patch.yml` | bundle 补丁，`insert` 一个 `id: quick-run` 条目 |
| `locale/zh.json`、`locale/en.json` | 插件管理器里的标题 / 描述 |
| `icon.svg` | 插件图标 |
