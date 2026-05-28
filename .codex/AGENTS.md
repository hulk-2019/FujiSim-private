# AGENTS.md - React & Rust 项目开发规范

本文件是 Codex 的行为约束指南，Codex 在协助进行本项目（包含 React 前端和 Rust 后端/桌面端）的开发、重构、测试和调试时，**必须严格遵守**以下规范。

---

## 1. 项目常用指令 (Commands)

根据具体使用的技术栈，Codex 可以运行以下命令进行构建、测试和代码检查：

### 前端 (React / TypeScript / Node.js)
* **安装依赖**: `pnpm install` (首选) 或 `npm install` / `yarn install`
* **启动开发服务**: `pnpm dev`
* **构建项目**: `pnpm build`
* **运行单元测试**: `pnpm test`
* **静态检查 (Lint)**: `pnpm lint` / `npx eslint .`
* **代码格式化**: `pnpm format` / `npx prettier --write .`

### 后端/核心 (Rust / Cargo)
* **构建**: `cargo build` (开发) / `cargo build --release` (发布)
* **运行测试**: `cargo test`
* **静态检查 (Clippy)**: `cargo clippy --all-targets --all-features -- -D warnings`
* **代码格式化**: `cargo fmt --all --check` (检查) / `cargo fmt --all` (格式化)
* **运行应用/服务**: `cargo run`

---

## 2. React & TypeScript 编码规范

### 2.1 组件设计与编写
* **函数式组件**: 必须使用函数式组件（FC），禁止使用类组件。优先使用传统的函数声明（`export function Component() {}`）或具有类型定义的箭头函数（`const Component: React.FC = () => {}`）。
* **单一职责**: 每个文件原则上只导出一个主要组件。**如果文件中包含子组件，必须单独定义并显式导出**（或推荐直接提取到独立文件中），严禁编写未导出的局部子组件，确保组件的复用性与测试性。
* **Hooks 规则**: 
  * 必须遵守 React Hooks 限制规则，不得在循环、条件判断或嵌套函数中调用 Hooks。
  * 复杂状态逻辑应抽离为自定义 Hook（例如 `useUserData`），保持组件逻辑清爽。
  * `useEffect` 必须明确声明依赖项，严禁空置依赖导致无限循环，或遗漏依赖导致闭包陷阱。
* **组件状态**: 优先选择本地状态（`useState`），跨组件状态优先考虑 React Context，全局复杂状态推荐使用 `Zustand` 或 `Redux Toolkit`，避免过度设计。

### 2.2 TypeScript 类型安全
* **严禁使用 `any`**: 必须明确声明所有变量、函数参数及返回值的类型。在过渡期或特殊动态场景，优先使用 `unknown` 并通过类型守卫（Type Guards）进行收窄。
* **声明选择**:
  * 内部数据结构、公共 API 参数及返回类型优先使用 `interface`（支持继承和自动合并）。
  * 联合类型、交叉类型、工具类型（Utility Types）及简单数据结构使用 `type`。
* **Props 类型约束**: 组件属性必须显式定义 Props 接口，例如 `interface ButtonProps { ... }`。可选属性使用 `?`，并设置合理的默认值。
* **非空断言**: 尽量避免使用非空断言操作符 `!`，应当通过 `?.`（可选链）或 `??`（空值合并）安全处理。

### 2.3 代码风格与最佳实践
* **文件行数限制**: **单个 React 组件或 TypeScript 文件（`.tsx`, `.ts`）的代码总行数绝不能超过 500 行**。如果代码量接近或超出 500 行，必须将逻辑、子组件或工具函数拆分到独立的模块或文件中。
* **文件命名**: 
  * 组件文件使用 **PascalCase** 命名，如 `Button.tsx`、`UserProfile.tsx`。
  * 普通逻辑/Hook 文件使用 **kebab-case** 命名，如 `use-local-storage.ts`、`api-client.ts`。
* **样式处理**:
  * 优先采用 `Tailwind CSS`，保持类名整洁。复杂条件渲染时使用 `clsx` 或 `tailwind-merge` 拼接。
  * 如使用 CSS Modules，样式文件命名为 `Component.module.css`。
* **路径别名**: 导入内部模块时，禁止使用多层相对路径（如 `../../../components`），必须使用别名（如 `@/components`）。
* **导入顺序规范**:
  1. React 及核心库（如 `react`, `react-router`）
  2. 第三方依赖库（如 `lucide-react`, `zustand`）
  3. 路径别名导入的公共组件/Hooks/工具方法（如 `@/components`, `@/hooks`, `@/utils`）
  4. 相对路径导入的局部模块及样式文件（如 `./sub-component`, `./style.module.css`）

---

## 3. Rust 编码规范

### 3.1 编码风格与命名
* **文件行数限制**: **单个 Rust 源代码文件（`.rs`）的代码总行数绝不能超过 500 行**。当单个文件过于臃肿时，必须通过合理划分子模块（`mod`）进行代码拆分与解耦。
* **严格遵循官方风格**: 必须运行并满足 `cargo fmt` 和 `cargo clippy` 的标准。
* **命名规范**:
  * 变量、函数、方法、模块名：下划线命名法 (`snake_case`)
  * 结构体、枚举、Trait、泛型参数：大驼峰命名法 (`UpperCamelCase`)
  * 常量、静态变量：大写下划线命名法 (`SCREAMING_SNAKE_CASE`)
* **不安全代码 (`unsafe`)**: 除非有极高性能要求或 FFI 交互，**严禁使用** `unsafe` 块。任何 `unsafe` 代码必须附带 `// SAFETY:` 注释，解释为什么此操作是安全的。

### 3.2 错误处理 (Error Handling)
* **严禁在生产代码中使用 `.unwrap()` 或 `.expect()`**: 
  * 任何可能失败的操作（如文件读写、网络请求、数据解析）必须返回 `Result` 或 `Option`。
  * 在测试代码、示例或无法恢复的系统级故障中，允许使用 `.expect("描述性文字")`，但必须说明理由。
* **错误定义**:
  * 应用级错误处理：使用 `anyhow` 库来捕获和传播混合错误。
  * 库级/精确错误处理：使用 `thiserror` 库，通过枚举精确定义每种错误，并利用 `#[error("...")]` 提供清晰的错误信息。
* **错误传播**: 优先使用 `?` 操作符将错误向上抛出，不要在底层吞掉错误（除非有明确的退避或降级逻辑）。

### 3.3 并发与异步
* **异步运行时**: 默认采用 `tokio` 异步运行时。
* **非阻塞原则**: 异步任务（`async fn`）中，绝不能执行会阻塞线程的同步阻塞操作（如标准库中的 `std::fs` 或 `std::thread::sleep`）。如有必要，应使用 `tokio::fs` 或将阻塞任务放进 `tokio::task::spawn_blocking` 中运行。
* **并发控制**: 
  * 跨线程共享状态时，必须使用线程安全的智能指针与同步锁，如 `Arc<Mutex<T>>` 或 `Arc<RwLock<T>>`。
  * 优先选择 `tokio::sync` 下的异步锁，而非标准库 `std::sync` 的同步锁，以避免死锁或阻塞异步调度器（仅在持锁时间极短且不跨越 `.await` 时才使用标准同步锁）。

### 3.4 资源管理与内存优化
* **减少不必要的克隆 (`.clone()`)**:
  * 避免在大结构体或频繁调用的逻辑中盲目使用 `.clone()`。
  * 优先通过引用（`&T` 或 `&mut T`）传递数据。
  * 适当时使用 `std::borrow::Cow`（写时复制）或 `Arc` 来共享大块只读数据。
* **生命周期**: 保持生命周期参数简洁明了。如果生命周期可以通过省略规则（lifetime elision）隐式处理，则不要手动标注。

---

## 4. 前后端交互与数据流规范

如果项目采用 React + Rust 架构（如 Web 应用程序、Tauri 桌面端应用、WASM 组件）：
* **强类型对齐**: 前后端交互的数据结构（API DTO、Tauri IPC 消息等）必须保持严格一致。
  * Rust 端使用 `serde::Serialize` 和 `serde::Deserialize` 派生宏，并使用 `#[serde(rename_all = "camelCase")]` 属性，确保序列化后的字段符合前端 JavaScript 驼峰规范。
  * 优先推荐使用类型生成工具（如 `ts-rs` 或 `specta`）自动将 Rust 的 DTO 结构体导出为 TypeScript 接口，禁止手动且容易出错地双向维护两套字段定义。
* **网络请求与异常响应**:
  * 后端接口必须返回结构统一的 JSON 响应，包含成功标志、数据负载（Payload）和错误明细。
  * 前端发起请求时，必须包裹 `try-catch` 或提供全局 Axios/Fetch 拦截器，捕获非 2xx 状态码及网络异常，并向用户显示友好提示，同时将错误记录到控制台或日志系统。

---

## 5. Codex 交互守则 (AI Instructions)

当 Codex 在此项目中生成或重构代码时，必须遵守以下操作规范：

1. **先思考、后编码 (Think Before Coding)**: 在提供或修改复杂逻辑前，先梳理清楚数据结构变化、潜在边界情况以及对现有系统的副作用。
2. **保持代码精炼 (Keep It DRY & KISS)**: 避免过度设计，尽量编写自解释、无冗余、模块化的高质量代码。
3. **单文件代码行数硬限制**: **严格控制任何单一文件（包括 `.ts`, `.tsx`, `.rs` 等）的代码行数不超过 500 行**。在生成、修改或重构代码时，若单文件代码预计或已经超过 500 行，**必须**主动将其拆分、解耦或提取至新文件、新模块中。
4. **安全修改 (Safe Modification)**: 
   * 修改已有文件时，只修改必要部分，绝不能无故删除原有的注释、其他功能代码或必要的辅助方法。
   * 优先保持原有的代码风格、命名规范和排版。
5. **自动化检查 (Automated Checks)**: 
   * 在对 Rust 代码进行重大修改后，**必须**主动运行 `cargo clippy` 和 `cargo test` 以确保代码质量和功能正确性。
   * 在对 React 代码进行重大修改后，**必须**主动运行 `pnpm lint`（或相应的 lint 指令），确保没有引入排版、未使用变量或类型错误。
6. **单元测试伴随 (Write Tests)**: 核心业务逻辑、复杂算法、工具函数在新增或重大修改时，必须伴随编写对应的单元测试（Rust 使用 `#[test]` 模块，TS 使用 `jest`/`vitest`/`playwright` 等相应配置）。
7. **提供高质量 Commit Message**: 如果被要求提交代码，请编写符合 **Conventional Commits** 规范的说明，如 `feat(backend): ...` 或 `fix(ui): ...`。