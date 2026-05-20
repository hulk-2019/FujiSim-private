use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// 导出任务队列：控制并发数量，跟踪取消状态。
///
/// 并发控制通过原子计数器实现；取消信号通过共享集合传递给 rayon 工作线程。
/// 实际的"取下一个 pending 任务并启动"逻辑在 `ipc::dispatch_pending` 中，
/// 因为它需要访问数据库连接池和 Tauri AppHandle。
pub struct TaskQueue {
    /// 最大并发导出任务数（默认 2）
    pub max_concurrent: usize,
    /// 当前正在运行的任务数
    running_count: AtomicUsize,
    /// 已被用户取消的任务 id 集合，rayon 工作线程每张图前检查
    cancelled: Mutex<HashSet<i64>>,
}

impl TaskQueue {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            max_concurrent,
            running_count: AtomicUsize::new(0),
            cancelled: Mutex::new(HashSet::new()),
        }
    }

    pub fn running(&self) -> usize {
        self.running_count.load(Ordering::SeqCst)
    }

    pub fn can_start_more(&self) -> bool {
        self.running() < self.max_concurrent
    }

    /// 原子地检查是否有空闲槽位并占用一个，返回 true 表示成功获取槽位。
    /// 相比 can_start_more() + on_task_start() 分开调用，消除了并发竞争窗口。
    pub fn try_acquire(&self) -> bool {
        loop {
            let cur = self.running_count.load(Ordering::SeqCst);
            if cur >= self.max_concurrent {
                return false;
            }
            if self.running_count
                .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return true;
            }
        }
    }

    /// 任务开始时调用，递增计数器
    pub fn on_task_start(&self) {
        self.running_count.fetch_add(1, Ordering::SeqCst);
    }

    /// 任务结束时调用，递减计数器并清理取消标记
    pub fn on_task_finish(&self, task_id: i64) {
        self.running_count.fetch_sub(1, Ordering::SeqCst);
        if let Ok(mut set) = self.cancelled.lock() {
            set.remove(&task_id);
        }
    }

    /// 标记任务为已取消，rayon 工作线程会在下一张图前检测到并跳过
    pub fn cancel(&self, task_id: i64) {
        if let Ok(mut set) = self.cancelled.lock() {
            set.insert(task_id);
        }
    }

    /// 清除取消标记（用于重试：任务重新入队前必须先解除取消状态）
    pub fn uncancel(&self, task_id: i64) {
        if let Ok(mut set) = self.cancelled.lock() {
            set.remove(&task_id);
        }
    }

    pub fn is_cancelled(&self, task_id: i64) -> bool {
        self.cancelled
            .lock()
            .map(|s| s.contains(&task_id))
            .unwrap_or(false)
    }
}
