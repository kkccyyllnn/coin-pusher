# abeto《Messenger》材质思路拆解 —— 面向 coin-pusher 的复用笔记

抓取时间 2026-09-29，站点 https://messenger.abeto.co/ （three r180 + postprocessing 6.3x）。
本项目是 three **0.184.0**、Vite + TS、`onBeforeCompile` 补 `MeshToonMaterial` 的路线。

**这份文档什么时候失效**：① 站点改版；② 我们换了渲染路线（比如真的上了后处理链，那么第 4 节的成本账要重算）；③ 任何标了 `待验证` 的条目——那些我没跑过，别当结论用。

---

## 0. 一句话

他的「材质」不是一个 shader，是**三件事咬在一起**：

1. **通道复用** —— 把非颜色数据（面 ID、深度、线宽权重）塞进 `gl_FragColor.a` 和一张第二附件，让材质之间互相"认识"；
2. **二值化合成** —— 光照结果不是算出来的，是拿 Photoshop 混合模式 / HSV 偏移 / `step()` **叠**出来的；
3. **后处理描边** —— 描边不属于任何物体，属于屏幕；材质只负责"把足够的信息交出去"。

所以抄他不能只抄某一段 GLSL。**第 1 条是地基**，没有通道复用，第 3 条的描边就没有输入。

---

## 1. 可迁移度总表

| # | 他的做法 | 迁移度 | 阻塞点 / 前置 |
|---|---|---|---|
| A | `gl_FragColor.a` = 面 ID（世界坐标哈希） | ★★★ 直接抄 | 必须先有渲染目标：canvas 是 `alpha:false` |
| B | MRT 第二附件 `gInfo = (深度, 法线.xy, 线宽权重)` | ★★★ 可抄 | r184 API 已核实：`{count:2}` |
| C | 后处理 Sobel 描边（ID/深度/法线三通道） | ★★☆ 要新子系统 | 我们现在**完全没有后处理链** |
| D | 线宽用噪声 `step()` 断续（手绘感） | ★★★ 直接抄 | 无。可以只作为 C 的子部分先做 |
| E | 阴影 = HSV 偏移（色相 -0.02、明度 ×0.5） | ★★★ 直接抄 | 我们 `RAMP_PALETTES` 已经在做同类事，先对齐口径 |
| F | Photoshop 混合模式 GLSL 库 `blend(x,y,opacity)` | ★★★ 直接抄 | 注入点在 `<lights_fragment_end>` 之后 |
| G | `step()` 优先于 `smoothstep()`（硬边色块） | ★★★ 风格纪律 | 无 |
| H | GLSL 用模块字符串拼装（`*_default` chunk 库） | ★★★ 同一条路 | 已核对：我们就是 `src/render/glsl/*.glsl.ts`（`colorRamp/detail/noise/rim` 四个模块），且同用 `/* glsl */` 模板字符串 |
| I | 3D LUT 调色（`sampler3D` + 四面体插值） | ★☆☆ 谨慎 | 与 `ACESFilmic` 叠加会打架，二选一 |
| J | 屏幕空间常量宽度 ribbon（烟/轨迹） | ★☆☆ 按需 | 我们没有曲线类特效需求 |
| K | 写 `gl_FragDepth` 扰动深度 | ★☆☆ 谨慎 | 会禁掉 early-Z；与 PCF shadow / 深度复用要实测 |
| L | 裸 `ShaderMaterial` + 手写 `getShadow()` | ✗ 别抄 | 与 `ToonMaterial.ts` 头部的论证直接冲突 |
| M | Slug/MSDF 把 UI 全画进 3D | ✗ 别抄 | 成本在 glyph worker 与字体管线，不在 shader |

---

## 2. 值得抄的六条，逐条拆开

### A. 把面 ID 塞进 alpha —— 零成本拿到"物体之间必有描边"

他的叶子材质（真源：`mats/trees_leaves.frag.glsl`）：

```glsl
float surfaceId = fract((vCentrTree.x + vCentrTree.y + vCentrTree.z) * 3.424);
gl_FragColor = vec4(color, surfaceId);
```

**为什么妙**：`surfaceId` 不是枚举、不是 instanceID、不是额外 uniform，是**世界坐标哈希出来的标量**。于是"两个不同物体相邻"自动等价于"alpha 不连续"，后处理只要比较 alpha 就能画边界。加新物体**不需要注册 ID**，美术管线零负担。

**搬到 coin-pusher**：注入点选 `<dithering_fragment>`（它是 `meshtoon` 片元尾段最后一个 include，见 `node_modules/three/src/renderers/shaders/ShaderLib/meshtoon.glsl.js`）。

```glsl
// 替换 #include <dithering_fragment>
gl_FragColor.a = fract(dot(vWorldPos.xyz, vec3(12.9898, 78.233, 37.719)) * uIdSalt);
```

**三个必须记住的口径**（都已在 r184 源码核实）：

1. `OPAQUE` define 的条件是 `transparent === false && blending === NormalBlending && alphaToCoverage === false`（`WebGLPrograms.js:259`）。点亮时 `opaque_fragment` 会把 `diffuseColor.a = 1.0` —— 所以**必须在它之后覆盖**，不能指望改 `opacity`。
2. `Material.premultipliedAlpha` 默认 **false**（`Material.js:415`），所以 `premultiplied_alpha_fragment` 的 `rgb *= a` 默认不生效。**但一旦有人开它，RGB 会被我们的 ID 乘没** —— 这是个静默陷阱，值得在工厂里 assert 一下。
3. ID 是 `fract()` 出来的连续标量，量化到 8-bit 附件后**相邻物体的 ID 差可能小于噪声**。他的后处理为此专门留了 `idMinScale`（远处/小面把 ID 线淡出）和 `idRange = (min, max, threshold)` 三元阈值。我们如果只有一屏几十个体，可以先不管，但**判据要按"最小可分 ID 差"设计**，别按"看起来有描边"。

### B. MRT 第二附件 —— 一遍几何 pass 同时交出色 + 深度 + 法线 + 线宽

```glsl
layout(location = 1) out highp vec4 gInfo;
gInfo = vec4(1.0 - (0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5),  // r: 反转透视深度
             encodeNormalSpheremap(worldNormal),                               // gb: 球面图法线
             outlineContribution);                                             // a: 该像素的线宽权重
```

**关键成本认知**：MRT 是**同一次 draw 多写一个附件**，drawcall **不翻倍**。涨的是带宽和一个 RT。这对我们 `drawcall ∈ [40,50]` 的预算是友好的，对 `programs < 30` 也友好（多一个输出不新增 define，但**新增材质变体**：任何"要不要写 gInfo"的开关都会翻倍程序数 —— 所以要么全写，要么用 layer 分 pass，别用 define）。

`待验证`：`onBeforeCompile` 里加 `layout(location=1) out` 时，three 的 GLSL3 兼容前缀会把 `gl_FragColor` 映射成 `pc_fragColor`（`WebGLProgram.js:817`），第二输出要自己声明。这条我**没在我们项目里跑过**，先拿一个空场景做最小复现再谈集成。

### C. 后处理描边 —— 不是"背面外扩"，是 G-buffer 上的 Sobel

他的 `outline()`（真源：bundle offset 1196539）取 5 个十字采样点，对 **ID / 深度 / 法线** 三个通道各算一次中心差分梯度模长，再过 `fit(fit(变化量, range.x, range.y, 0, 1), range.z, range.z + smoothMargin, 0, 1)`，最后加权。三个细节值得抄：

- **法线朝向影响深度阈值**：`float depthLimit = depthRange.z + 1.0 - centerNormal.z;` —— 掠射面本来就看不清，就放宽它的描边门槛。这一行比任何"调参"都值钱。
- **距离淡出**：`resScale = min(1.0, resolution.y / 1300.0) * uOutlineScale`，线宽跟分辨率挂钩。**注意**：我们有 `PixelScale` 整数倍率档，`resolution.y` 会随档位跳变 ⇒ 同一帧内容描边粗细会变。要么把 `resScale` 的分母换成"CSS 高度"这种与倍率无关的量，要么判据里显式接受它。
- **半透明物体的深度参与**：他用水深和 `nearestDepth` 比较，水下就不描边（`if (nearestDepth < waterDepth) outlineUnderWater = 0.0;`）。对应到我们：落币导槽那类半透明件，如果不做这个抑制，描边会浮在币上。

### D. 线宽本身是噪声 —— 手绘感的技术定义

```glsl
float outlineContribution = step(sinenoise1(vec3(vUv * 2.0, vRand.x + vRand.w * 34.32)), 0.35);
```

**这是整份文档里最"风格"的一条**：描边不是实线，是**每像素随机断开的线**。而且用的是 `sin()` 值噪声，不采纹理。

**我们已经有等价物**（现读 `src/render/glsl/noise.glsl.ts`，60 行）：`HASH_GLSL` 的 `sdHash12(vec2)`、`VALUE_NOISE_GLSL` 的 `sdNoise(vec2)`、`FBM2_GLSL` 的 `sdBand2(vec2)`，而且同样是 `/* glsl */` 模板字符串模块 —— H 那条路我们早就在走。

**唯一的口径差**：我们的噪声全是 **2D**，他的 `sinenoise1` 收 `vec3`，第三维当时间用（`sinenoise1(vec3(vUv*2.0, vRand.x + vRand.w*34.32))` 里的 `vRand` 就是"每个物体不同相位"）。所以要做**会动的**断线，得先补一个 3D 变体，或者把 `vec2(sdNoise(p + timeOffset))` 这类做法显式定成一个约定 —— 别在调用点各自凑。

这条**可以脱离 C 单独用**：先给现有 rim / 边缘效果加一个 `step(noise)` 的断口，就能立刻看出是不是我们要的手绘感，成本 = 0 个新 pass。

### E + F. 阴影是调色板操作；合成靠混合模式库

他的叶子暗面不是乘个暗色，是：

```glsl
vec3 colorhsv = rgb2hsv(grassColor);
colorhsv.r -= 0.02;      // 色相偏一点
colorhsv.b *= 0.5;       // 明度砍半
vec3 color = mix(hsv2rgb(colorhsv), grassColor, smoothstep(0.0, 0.1, light));
```

而 `light` 本身是 `min(dot(N, L), shadow)` —— **阴影直接被当成光照因子的上界**，一次 `min` 就把 shadowmap 融进赛璐璐分档。

另外他有一整套 `blend(x, y, opacity)`：`normal / multiply / screen / overlay / hard_mix / linear_dodge / linear_burn / linear_light / luminosity / saturation / hue / invert / negation / subtract`（真源：bundle 里 `light_default`、`hard_mix_default`、`luminosity_default` 等 chunk）。**"给材质加效果"在他的代码里是"叠一层 Photoshop 图层"**，而不是"加一个物理项"。这跟我们 `RampLut` 的思路同源，但表达力强得多 —— 尤其 `hard_mix` 和 `linear_dodge` 是"低多边形 + 高饱和"风格里最好用的两把刀。

> 对我们更省事的一点：`rgb2hsv` 这条路线我们已经用 **RGB 色带 + 背面色带** 覆盖了大半（见 `ToonMaterial.ts` 的 `COLOR_RAMP_CHUNK`）。**别重复造**。真正缺的是 `blend()` 这套合成算子。

### G. 二值化优先 —— 一条风格纪律

他全篇的渐变都是 `step()`：海面 `step(0.1, pow(noise,2))`、浪花 `step(0.42, foam)`、描边断口 `step(noise, 0.35)`。`smoothstep` 只出现在**必须过渡**的地方（明暗交界、阈值边缘的抗锯齿）。

对我们的意义：任何"看起来糊"的问题，先怀疑**该 `step` 的地方用了 `lerp`**。

---

## 3. 明确不建议抄的两条

- **L. 裸 `ShaderMaterial`**：他确实全裸写（`lights:true` + 手动 `getShadow(directionalShadowMap[0], ...)`），但 `ToonMaterial.ts` 头部已经论证过反方向选择的理由（阴影/多光/fog/色彩空间/色调映射/实例化白送，且 three 升级不用跟着修）。他的裸写换来的是**完全掌控输出通道**——我们要通道复用，用 `onBeforeCompile` 在尾部覆盖也能拿到，不必推翻路线。
- **M. 全 3D UI**：他的对话框/按钮/任务面板/emoji 全是带 shader 的网格（材质名 `button`、`textbox-bg`、`questbox-bg`、`emojilist-bg`、`npc-icon`…），文字用 **Slug**（Figma 那套 SDF，GLSL 里有 `SlugVS / GlyphUnpack / jacobian / bandTexture / CalcRootCode / SolveHorizPoly`）+ MSDF，并且 `glyphworker` / `msdfworker` 在 worker 里生成。这是一条**独立的前端基建投资**，不是材质技巧。

---

## 4. 与本项目硬预算的冲突账

| 预算 | 影响 | 结论 |
|---|---|---|
| `programs < 30`（现 24~25） | 描边 pass 需要：1 个全屏 quad 材质 + 每个"要写 gInfo"的材质**不新增程序**（多输出不是新 define） | 净 +1，可接受。**红线**：任何 `#ifdef WRITE_GINFO` 都会让变体翻倍，禁止 |
| `drawcall ∈ [40,50]` | MRT = 同遍多附件，不翻倍；描边 pass = +1；若再上 SMAA/泛光则 +N | 只做 C（一个 pass）≈ +1；**别顺手把 postprocessing 全家桶装上** |
| canvas `alpha:false`（`Renderer.ts:8`） | 现在**根本没有 alpha 通道可用**，A 必须先引入 `WebGLRenderTarget` | 这是 A/C 的**真正前置**，不是 shader 问题 |
| `antialias: true` + `PixelScale` 整数倍率 | 改走 RT 后 MSAA 要变成 `samples: N`（他用的 4），且描边线宽随倍率档跳变 | 需要一次专门的分辨率口径核对 |
| `ACESFilmic` + exposure 1.05 | 与 I（3D LUT）叠加会双重调色 | 二选一。他**没有**用 ACES，靠 LUT + 平涂背景 |
| 半透明件（落币导槽） | 无 C 的深度抑制时描边会浮在币上 | 属于 C 的收尾项，不是首期 |

---

## 5. 建议落地顺序（每组只动一个变量，独占窗口）

- **第 0 组｜纯风格，零基建**：只做 D（`step(noise)` 断口）+ G（把该硬的地方 `step` 化）。判据：截图对比 + 现有 visual spec 全绿。**这一组就能验证"是不是我们要的手绘感"**，成本最低，先做。
- **第 1 组｜通道复用**：引入一个 `{count:2}` 的 RT（B），材质尾部写 A 的 `surfaceId` 和 gInfo。**此组不接任何描边消费端**，只证明"数据真的到了附件里"（把附件直接画出来 debug）。
- **第 2 组｜描边 pass**：C 的 `outline()`，先只用 ID 通道，深度/法线通道留 0 权重。
- **第 3 组**：补深度/法线通道 + 距离淡出 + 半透明抑制。
- **第 4 组（可选）**：`blend()` 算子库进 `src/render/glsl/`。

第 1 组是**唯一的架构级改动**（第一次让场景渲染进 RT 而不是 canvas），风险集中在这里。

---

## 6. 判据草案（阈值要离噪声远）

描边这类效果**没有单值真源**，别写"描边覆盖率 = X" 这种硬判据。可用的口径：

1. **恒等性判据（最强）**：关掉描边强度 ⇒ 输出与 baseline **逐像素全等**。这是逐事件恒等式，不是分布统计，能进 CI。
2. **分布判据**：边缘像素的"暗于邻域 > 阈值"计数，跨 n≥20 帧取分布，比较的是**分布位移**而不是单帧读数。
3. **可读性判据**：半透明双面板（导槽）在开/关背面色带时的区分度 —— 这条我们已有等价测试（`rampBack` 的动机注释）。
4. `待验证`：ID 通道的最小可分差 —— 需要在 8-bit 附件上实测"两个相邻物体的 `fract()` ID 差"分布，再定 `idRange.x`。**先测后定阈值**，不要从他的数值抄（他的场景尺度和我们的柜体不同）。

---

## 7. 证据附录

**我实际跑过的验证**（不是推测）：

- 站点：HTML 1.7KB / 入口 3.8KB / 主 chunk 1.9MB / CSS 1.5KB；bundle 内 `REVISION="180"`，与 npm `three@0.180.0` 的 `src/constants.js` 一致。
- 从 bundle 提取 **106 段独立 GLSL**、**28 个 `hotReload` 材质名**；`postprocessing` 归属用 6.39.5 的 build 逐字命中（`vUvDown`、`smaa_weights`、`convolution_kawase`、`KawaseBlur`、`ToneMappingEffect`）；three 自带 `UnrealBloomPass` 命中数 0。
- `three-mesh-bvh` 归属：`MeshBVH` / `TRAVERSAL_COST` / `partition()` 在包内，且有 `collider.prototype.raycast = acceleratedRaycast` + `collisionworker-*.js`。
- 本项目 r184 侧核实：`opaque_fragment` 内容、`OPAQUE` define 条件（`WebGLPrograms.js:259`）、`Material.premultipliedAlpha` 默认 false（`Material.js:415`）、`meshtoon` 尾段 include 顺序、GLSL3 兼容前缀（`WebGLProgram.js:809/810/815/817`）、MRT = `RenderTarget` options `count`（`src/core/RenderTarget.js:137-143` + `WebGLState.drawBuffers` 按 `textures.length` 接 `COLOR_ATTACHMENT*`）。
- 视觉：实测标题页（星球自转、3D 挤出字、橙色 ENTER、平涂青绿背景 + 云斑）。

**没验过的**：`ENTER` 对合成 pointer 事件无响应，**游戏内画面没截到** ⇒ 玩法层判断只来自材质名与音频资源名（`ambiances/{beach,city,factory,forest,temple,waterfalls}.ogg`、`dialogues/{male,female}{1,2,3}.ogg`、`character/footsteps*.ogg`）。第 2 节 B 条的 `onBeforeCompile + MRT` 组合、第 6 节第 4 条，都标了 `待验证`。

**提取产物**（临时目录，会被清）：`/tmp/abeto/glsl/`（106 段 + `INDEX.txt`）、`/tmp/abeto/mats/`（按材质名配对的 vert/frag）、`/tmp/abeto/assets.txt`。要长期留，就把 `/tmp/abeto/mats/` 拷进仓库，别依赖这个路径。

---

## 8. 抄的时候最容易踩的三个坑

1. **反引号**：往 glsl 模板字符串里插注释时，注释里出现反引号会**截断整个模块**，而且报错指不到真因（本项目已踩过三次）。GLSL 注释里只写 `//` 和普通文字。
2. **`fract()` 哈希不是唯一 ID**：它只是"几乎必然不同"。任何依赖它的判据都要按**可分差**设计，不是按"相等/不等"。
3. **别拆开抄**：只抄 C（描边 pass）不抄 A/B（通道复用），会得到一个"只有深度描边、物体之间没线"的四不像 —— 那时第一反应会是"参数没调好"，其实是输入信息不全。**判据：先看 gInfo 附件 debug 图，再调 outline 阈值。**
