## 针对“支持调色的权威 Baseline 预览图”的高性能重构方案

在专业的 RAW 调色与后期处理软件（如 Lightroom、DaVinci Resolve）中，为了在保证色彩科学绝对权威（100% 还原 RAW 宽容度）的同时实现交互滑块毫秒级响应（60 FPS 级丝滑），不能采用常规的单向线性管道，而是需要采用**“代理缓存（Proxy Cache）”与“动静分离（Decoupling）”**的现代色彩管理架构。
由于调色（Color Grading）必须在**保存了原始物理曝光和宽容度的线性数据（Linear Data）**上进行，传统的“直接提取机内 JPEG”确实不适用。

以下是专门针对**“支持调色的权威 Baseline 预览图”**量身定制的高性能优化与重构方案。

### 一、 传统管道的性能瓶颈分析
您原先的管道：
Read RAW -> LibRaw 解码/Demosaic -> 转 RGB16 -> Baseline Tone -> Resize -> Encode JPEG
该流程存在三个致命的性能与数学设计痛点：
在全分辨率上做无用功：在一张 2400万 ~ 4500万像素的大图上做复杂的数学运算（Gamma、对比度曲线、色彩矩阵），然后把 90% 以上算好的像素在 Resize 阶段直接丢弃，造成极大的算力浪费。
内存带宽饱和：RGB16 的数据量是 RGB8 的两倍。在全分辨率下，庞大的 16-bit 吞吐量极易使 CPU 缓存失效，导致内存总线成为瓶颈。
“晚缩放”违反色彩学规律：在非线性空间（即应用了 Baseline Tone / Gamma 映射后）进行 Resize，双线性/双三次插值会破坏物理光学的线性加性原理，导致高光边缘塌陷、暗部偏色以及高对比边缘出现黑边。

### 二、 核心重构思想：“动静解耦”与“先缩放，后色调”
为了解决上述痛点，我们将整个图像处理管道重构为静态一次性加载阶段（Static Load）与动态交互渲染阶段（Dynamic Interactive）。

【 静态加载阶段（仅在载入RAW或切换画质时运行一次）】
RAW 文件 ──> LibRaw 快速解码 ──> 线性 RGB16 (全/半分辨率) ──> 线性快速 Resize ──> 内存缓存：Linear RGB16 2K 代理图

【 动态交互阶段（每次拖拽调色、曝光、对比度滑块时实时运行，耗时 < 10ms）】
Linear RGB16 2K 代理图 ──[白平衡/曝光/3D LUT]──> 1D/3D LUT 高速查表 ──> RGB8 ──> libjpeg-turbo 编码 / 屏幕显示

为什么这个架构能快 50 倍以上？
物理正确、色彩权威：在 Linear RGB16（线性空间） 下立即缩放（Resize）。不仅速度提升数十倍，而且在物理和色彩科学上更权威、更正确。
极小的计算负荷：将需要频繁计算的调色、色调映射、RGB8 转换、JPEG 编码等步骤，全部限制在 2K 分辨率（约 200 万像素）的代理图上进行。


### 三、 关键优化落地技术指南
1. 静态阶段：LibRaw 绝对线性配置与快速解码
在载入 RAW 文件构建线性缓存时，通过以下配置确保 LibRaw 输出无损、无伪色、无非线性操作的权威 Baseline 数据：

- 关闭一切自动处理，保留物理真实度：
code
C++
processor.imgdata.params.use_camera_wb = 1;      // 1. 使用相机拍摄时的白平衡系数作为基准
processor.imgdata.params.no_auto_bright = 1;     // 2. 必须关闭自动亮度！否则调色基准会随画面内容飘移
processor.imgdata.params.adjust_maximum_thr = 0;  // 3. 关闭自动最大值调整，保留完整的高光过曝临界点

- 输出 16-bit 绝对线性数据：
code
C++
processor.imgdata.params.output_bps = 16;        // 16位保证调色时暗部和高光不出现断层（Color Banding）
processor.imgdata.params.gamm[0] = 1.0;          // Gamma = 1.0（绝对线性空间）
processor.imgdata.params.gamm[1] = 1.0;          // Toe slope = 1.0

- 快速 Demosaic（根据预览精细度选择）：
快速整图预览：开启半尺寸解码 processor.imgdata.params.half_size = 1;（相当于 dcraw -h）。它不进行耗时的颜色插值，直接将相邻的 2x2 像素像素合并，速度提升 4x 以上，色彩纯度极高。
1:1 像素级细节预览：设置 processor.imgdata.params.user_qual = 0;（最快的双线性 Bilinear 插值）或 user_qual = 2（PPG 算法，速度与画质较平衡）。


2. 线性早缩放（Linear Early Resize）
在 Demosaic 完毕、得到全分辨率（或半尺寸）的 Linear RGB16 数据后，立即将其 Resize 到预览分辨率（例如长边 2048px 的 2K 图像）。
推荐算法：使用 Google libyuv 库或配置了 AVX2 编译支持的 OpenCV cv::resize（双线性 INTER_LINEAR 或双三次 INTER_CUBIC）。
为什么正确：此步操作依然处于线性空间，插值计算完全符合物理光子的加性叠加。

3. 动态阶段：调色与色调映射“一维查找表化（1D LUT）”
由于 16-bit 输入范围是固定的 0 ~ 65535，调色操作（如曝光、白平衡、对比度曲线、Gamma、色调映射等）可以通过一维数组进行查表加速，彻底消除逐像素浮点数学运算。
合并算法为单次查表：
当用户拖动调色滑块时，在内存中瞬间重建三个大小为 65536 的 uint8_t 一维数组（R, G, B 通道各一个）：
code
C++
uint8_t lut_R[65536];
for (int i = 0; i < 65536; ++i) {
    float val = (float)i / 65535.0f; // 归一化线性物理值
    
    // 1. 应用白平衡与曝光 (Exposure & White Balance Multipliers)
    val = val * u_exposure * u_wb_r;
    
    // 2. 应用 Baseline Tone Curve / Tone Mapping (如 ACES Filmic 或 Reinhard 算法)
    val = ApplyToneCurve(val); 
    
    // 3. 应用 Gamma 2.2 转换并映射到 8-bit 空间
    val = powf(val, 1.0f / 2.2f);
    lut_R[i] = (uint8_t)clamping(val * 255.0f, 0.0f, 255.0f);
}
极速渲染：
在渲染时，对 2K 代理小图的每个像素进行极速查表：
code
C++
// 该步骤可通过 SIMD (AVX2/NEON) 或 GPU Shader 进一步并行，耗时仅需 ~1ms
out_rgb8[idx].r = lut_R[linear_rgb16_proxy[idx].r];
out_rgb8[idx].g = lut_G[linear_rgb16_proxy[idx].g];
out_rgb8[idx].b = lut_B[linear_rgb16_proxy[idx].b];
4. 动态阶段：高阶色彩管理与 3D LUT 加速
如果需要将相机的原生色彩空间（如 Sony S-Gamut, Canon Cinema Gamut）转换为标准色域（sRGB 或 Display P3），需要执行 
3
×
3
3×3
 的色彩矩阵相乘或 3D LUT。
CPU 端优化：使用 SIMD（AVX2 / NEON） 指令集批量执行矩阵乘法。
GPU 端优化：在 Web 浏览器或 GUI 框架（如 Qt/Metal/DirectX）中，直接将 Linear RGB16 代理图作为纹理（Texture）上传至 GPU。在 Shader 中执行曝光、3D LUT、色调映射与 Gamma，实现 0 毫秒级的实时 60 帧无缝渲染，省去 CPU 端的转换开销。
5. 极速 JPEG 编码
预览图最终转换为 RGB8 后，通过以下手段最大化压缩速度：
使用 libjpeg-turbo 代替传统的 libjpeg。
开启 libjpeg-turbo 的 SIMD 汇编加速，利用多核 CPU 的并行优势，将 2K 图像的编码耗时压低至 2ms ~ 5ms。
四、 优化前后管道性能与架构对比
环节	传统慢速管道 (您的现状)	优化后的权威调色管道	性能/色彩增益
Demosaic 性能	全分辨率高性能插值 (极慢)	半尺寸（Half-Size）/ 快速双线性（Bilinear）	4x ~ 8x 提速
内存/计算带宽	保持全尺寸 RGB16 进行全程计算 (极重)	在线性阶段立即缩放到 2K（~2.0MP）	内存带宽与计算量降低 90%+
色彩科学权威性	晚缩放（在 Tone Mapping 之后缩放）	早缩放（在线性空间内立即缩放）	避免高光过曝黑边，100% 物理光子正确
色调映射计算	4500万像素逐像素浮点运算	在 2K 小图上，通过 1D LUT 查表处理	50x ~ 100x 提速，消除浮点数计算
调色响应延迟	每次拖动滑块重新解码渲染 RAW (2~5秒)	缓存线性代理图，动态重跑调色阶段 (< 10ms)	从严重卡顿直接提升至 60 FPS 实时交互