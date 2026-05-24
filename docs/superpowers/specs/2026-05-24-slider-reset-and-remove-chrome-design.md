# 滑块双击重置 + 移除色彩效果 设计文档

- 日期：2026-05-24
- 范围：编辑页右侧「调整」tab 的滑块交互与「颜色」Section 的色彩效果下拉
- 状态：设计已确认，等待实现

## 1. 背景

「调整」tab 上线 11 个 LR 风格的色调滑块后，遗留两个清理点：

1. 滑块缺少快捷重置入口。用户改坏一个值后只能拖回 0，体验差。LR / Adobe 系列产品的惯例是双击 thumb 重置回默认。
2. 「颜色」Section 中的「色彩效果」下拉（None/Weak/Strong）在新参数体系下显得多余——用户的色彩取向已由饱和度、鲜艳度、富士预设覆盖。color_chrome_effect 字段在前后端都还在，但没有实际产品意义。

## 2. 用户故事

1. 我要双击任意滑块的圆点，就把这一个参数重置到出厂默认（0）。
2. 我要看到「颜色」Section 不再出现「色彩效果」下拉。
3. 删除该字段不影响内置富士预设的视觉表现。

## 3. 双击重置

### 3.1 行为

- 触发区：仅 Radix `<Slider.Thumb>` 的圆点本身。点击轨道、标签均不触发。
- 重置目标：所有 11 个滑块统一为 `0`（与 `DEFAULT_FILTER` 一致）。
- 反馈：依赖现有响应链——重置后 `setFilter({field: 0})` 触发 store 更新→预览自动重新渲染。

### 3.2 实现

`src/components/ui/slider.tsx`：

```tsx
type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  onThumbDoubleClick?: () => void;
};

export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, onThumbDoubleClick, ...props }, ref) => (
  <SliderPrimitive.Root ref={ref} className={cn(...)} {...props}>
    <SliderPrimitive.Track ...>
      <SliderPrimitive.Range .../>
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      onDoubleClick={onThumbDoubleClick}
      className={...}
    />
  </SliderPrimitive.Root>
));
```

`src/components/ui/form.tsx::SliderRow`：

```tsx
export function SliderRow({
  label, value, min, max, step, onChange, display,
  resetValue = 0,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  display?: (v: number) => string;
  resetValue?: number;
}) {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-xs text-zinc-300">{label}</span>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          {display ? display(value) : value.toFixed(2)}
        </span>
      </div>
      <Slider
        value={[value]} min={min} max={max} step={step}
        onValueChange={([v]) => onChange(v)}
        onThumbDoubleClick={() => onChange(resetValue)}
      />
    </div>
  );
}
```

11 个 SliderRow 调用点不需要修改，`resetValue` 默认值 0 适用所有滑块。

### 3.3 测试

无后端变化；`pnpm tsc --noEmit && pnpm build` 校验类型与编译。手动 smoke：双击曝光/对比度/饱和度等滑块，验证回到 0。

## 4. 移除 color_chrome_effect

### 4.1 验证：fuji.rs 不需要改

经源码核查，`FujiProfile` 结构体**不包含** chrome_strength 字段。原本的 chrome 效果完全由用户在 UI 选择 None/Weak/Strong 触发，对应 pipeline 内 `chrome_strength: f32`（0/0.15/0.30）。删除 UI 后该值永远为 0，HSL 加权块整体跳过，对内置富士预设无影响。无需向 saturation 合并。

### 4.2 前端清理

- `src/components/FilterPanel.tsx`：
  - 删除 `CHROME_EFFECTS` 常量
  - 删除「颜色」Section 内 Select 块（约 `<div><Label>colorEffect</Label><Select>...</Select></div>`）
  - 删除 `saveAsPreset` payload 内 `color_chrome_effect: filter.color_chrome_effect ?? null`
- `src/types.ts`：
  - `FilterSettings` 删 `color_chrome_effect?: string | null;`
  - `FilterPreset` 删同字段
- `src/store/defaults.ts::DEFAULT_FILTER`：删 `color_chrome_effect: "None"`
- `src/store/slices/filter.ts::presetToFilter`：删 `color_chrome_effect: preset.color_chrome_effect ?? "None"`
- `src/components/PreviewPanel.tsx::isIdentity`：删 chrome 检查行 `(!filter.color_chrome_effect || filter.color_chrome_effect === "None")`
- `src/i18n/zh.ts` / `en.ts`：删 `filterPanel.colorEffect`
  - **保留** `filterPanel.strengthLabels.*` 与 `sizeLabels.*`（颗粒效果仍在使用）

### 4.3 后端清理

`src-tauri/src/processing/pipeline.rs`：

- `FilterSettings` 删 `pub color_chrome_effect: Option<String>`
- `is_identity` 删 chrome 检查行
- `Default::default()` 删字段
- `process_image` 内：删 `chrome_strength` 计算（约 line 165-169）和「[8] Color Chrome」HSL 加权块

`src-tauri/src/db/presets.rs`：

- `FilterPreset` 删 `pub color_chrome_effect: Option<String>`
- `NewFilterPreset` 删同字段
- `upsert` SQL：列从 22 → 21，`?` 从 22 → 21，`.bind` 从 22 → 21；ON CONFLICT 子句删 `color_chrome_effect=excluded.color_chrome_effect`

`src-tauri/src/db/mod.rs`：

- `SCHEMA` 内 `filter_presets` 表 DDL 删 `color_chrome_effect TEXT,`
- 第一段迁移数组追加 `"ALTER TABLE filter_presets DROP COLUMN color_chrome_effect"`（SQLite 3.35+ 支持；旧版本失败被现有 `let _ = ...` 模式忽略，遗留列不影响新写入）

`src-tauri/src/state.rs::seed_builtin_presets`：

- `NewFilterPreset { ... }` 字面量删 `color_chrome_effect: None`

### 4.4 测试

后端：`cargo build && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test`。现有 24 测试应仍通过——无算法层改动，仅字段拆除。

前端：`pnpm tsc --noEmit && pnpm build`。

手动 smoke：

1. 启动后「颜色」Section 仅显示鲜艳度、饱和度、色温 R/B（无色彩效果下拉）
2. 切换内置富士预设（Velvia、Classic Chrome）后，预览视觉与改动前比对应一致或仅有微小差异
3. 保存自定义预设、切走、回切，所有字段持久化正常
4. 双击曝光/对比度/任意滑块的 thumb，参数回到 0，预览实时跟随

## 5. 文件清单

新建：无

修改：

前端（8）：
- `src/components/ui/slider.tsx`
- `src/components/ui/form.tsx`
- `src/components/FilterPanel.tsx`
- `src/types.ts`
- `src/store/defaults.ts`
- `src/store/slices/filter.ts`
- `src/components/PreviewPanel.tsx`
- `src/i18n/zh.ts`
- `src/i18n/en.ts`

后端（4）：
- `src-tauri/src/processing/pipeline.rs`
- `src-tauri/src/db/presets.rs`
- `src-tauri/src/db/mod.rs`
- `src-tauri/src/state.rs`

总计 12 个文件，每个改动均控制在 50 行以内（仅字段移除 + 1 个新 prop 转发）。

## 6. 风险

1. **遗留数据库的 color_chrome_effect 列保留**：SQLite < 3.35 的 `ALTER TABLE DROP COLUMN` 失败被忽略，列继续存在。新代码不写入也不读取，无功能影响，仅 schema 视觉冗余。可接受。
2. **内置富士预设视觉变化**：删除 chrome HSL 加权后，原本启用 Weak/Strong 的预设会失去额外饱和提升。但 4.1 已分析：用户从未通过 UI 启用过该值（默认 "None"），且 13 个内置预设种子 `color_chrome_effect: None`，所以实际无人受影响。
3. **双击与单击的事件冲突**：Radix Slider Thumb 默认会监听 mousedown 用于拖拽。`onDoubleClick` 是浏览器层独立事件，不会与拖拽冲突——双击事件只在两次快速点击且 thumb 没有移动时触发，体验自然。

## 7. 范围外

- 整体 reset（一键重置整面板的所有参数到 0）。
- 长按 / 右键菜单提供更多重置选项。
- 数据迁移工具把已经写入 `color_chrome_effect != "None"` 的旧自定义预设字段值合并到饱和度（项目已 DROP TABLE 清空过用户预设，无遗留数据）。
