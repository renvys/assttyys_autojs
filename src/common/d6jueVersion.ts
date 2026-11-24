/**
 * 六道觉策略版本号。
 *
 * 只在一处维护，供分析日志/性能日志的 session 头、run.start 使用，
 * 这样拿到设备日志就能确认跑的是哪一版，而不必靠时间或事件特征反推。
 *
 * 规则：影响识别、步数、取点、流程策略的改动，提交前同步改这里。
 * 建议格式：<主题><序号>，例如 counter3+bannerRetry。
 */
export const D6_LOGIC_VERSION = 'stepTransition1+clickDist1+buffSimilar1+buffWait4+clickSmall1+mapCache2+stepGuard1+clearedChaos1+twoRight1+buffCont1+huanxiDeduct2+buffFast1';
