# 智慧教育平台自动连播

国家中小学智慧教育平台（basic.smartedu.cn）教师研修课程**自动连播**浏览器扩展（Manifest V3）。
当前视频播放完毕后，自动切换到目录中下一个未学习的视频并继续播放；支持后台播放与弹窗自动处理。

## 功能

- ✅ 视频播完自动切换下一个（**不加速、不跳过，正常速度播放**，符合平台"完整观看"要求）
- ✅ 自动展开折叠的课程目录（含多层嵌套章节），自动识别已完成/播放中/未开始状态
- ✅ **后台播放**：切换窗口 / 浏览器最小化 / 切到其他标签页时持续播放
  （平台会在失焦时暂停视频，插件注入"暂停守卫"拦截其 `video.pause()` 调用）
- ✅ **弹窗自动处理**：跳转视频后出现的提示弹窗（确定/知道了/继续等按钮）自动点击
- ✅ 右下角悬浮面板：实时状态 + 日志 + 开/关按钮（可拖动）

## 安装

1. 打开 Edge，地址栏输入 `edge://extensions` 回车
2. 打开右上角「开发人员模式」
3. 点「加载解压缩的扩展」，选择本文件夹
4. 打开课程页面即可使用（插件自动运行）

> 修改代码后：在扩展管理页点该扩展卡片上的「重新加载」按钮，再刷新课程页。

## 使用

1. 进入课程播放页（如 2026年"暑期教师研修"专题 → 某门课程）
2. **手动点一次播放**（解锁浏览器自动播放权限）
3. 之后每个视频播放完，插件自动点击目录中的下一个视频
4. 面板右上角「开/关」可随时暂停连播

## 建议浏览器设置

Edge 的「睡眠标签页」会冻结后台标签页（连插件定时器一起停），建议关闭：
`edge://settings/system` → 睡眠标签页 → 关闭

## 工作方式（技术说明）

- **连播**：监听 Video.js 播放器（`video.vjs-tech`）的 `ended` 事件 → 递归展开 `div.fish-collapse` 折叠目录 → 按状态图标（`icon_checkbox_fill` 已学完 / `icon_checkbox_linear` 未开始 / `icon_processing` 播放中）定位当前视频 → 模拟真实鼠标事件（pointerdown → mousedown → pointerup → mouseup → click）点击下一个 `div.resource-item.resource-item-train` 条目 → 用 `video.src`（blob）变化验证切换
- **后台播放**：监听 `visibilitychange` + 窗口 `blur` → 启动保活（AudioContext 静音保活 + 500ms 轮询恢复播放）→ 通过 background（`chrome.scripting.executeScript`，world: MAIN）注入 `HTMLMediaElement.prototype.pause` 守卫，拦截平台在失焦时的暂停调用；窗口聚焦后自动解除
- **弹窗处理**：视频暂停且存在可见弹窗（标准 modal / 高 z-index 覆盖层）时，自动点击"确定/知道了/继续/确认/关闭"等按钮，无匹配按钮则点右上角关闭 X

## 文件

- `manifest.json` — Manifest V3 清单（含 background + scripting 权限）
- `content.js` — 主逻辑（连播、保活、弹窗处理、日志面板）
- `background.js` — service worker（向页面主世界注入暂停守卫）
- `README.md` — 本说明

## 已知限制

- 仅适用于 basic.smartedu.cn 教师研修课程页
- 若平台改版导致选择器失效，日志会提示，需按新版 DOM 更新 `findVideoRows()` / `rowState()`
- 后台播放依赖浏览器不冻结标签页（建议关闭 Edge 睡眠标签页）
