/**
 * SaveAdapter · 存档适配：本地 ↔ 云端按 lastSeen 取新（口径同 H5 game.js queueCloud/merge）
 *
 * 约定：存档串为 JSON，含毫秒时间戳字段 lastSeen；谁新用谁，导入档强制覆盖云端。
 * 服务端 DEEP 校验是最后防线（装备/进度/自报战力上界），本地不做重复校验。
 */
const SAVE_KEY = 'lingxia_idle_v1';          // 与 H5 版一致，勿改
const LAST_SEEN_KEY = SAVE_KEY + '_seen';

export class SaveAdapter {
    constructor(private api: { saveGet(): Promise<unknown>; savePost(s: unknown): Promise<{ updatedAt: number }> }) { }

    localRead(): string | null {
        try { return localStorage.getItem(SAVE_KEY); } catch { return null; }
    }

    localWrite(text: string): void {
        try {
            localStorage.setItem(SAVE_KEY, text);
            localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
        } catch { /* 隐私模式忽略 */ }
    }

    /**
     * 启动合并：云端与本地按 lastSeen 取新；云新返回云端串（调用方负责落到本地与场景），
     * 本地新则补推云端。返回最终采纳的存档串。
     */
    async syncOnBoot(): Promise<string | null> {
        const localText = this.localRead();
        const localSeen = Number(localStorage.getItem(LAST_SEEN_KEY) || 0);
        let cloudText: string | null = null;
        let cloudSeen = 0;
        try {
            const raw = await this.api.saveGet();
            const obj = raw as { save?: string; updatedAt?: number } | null;
            if (obj && typeof obj.save === 'string') {
                cloudText = obj.save;
                cloudSeen = Number(obj.updatedAt || 0);
            }
        } catch { /* 未登录或断服：纯本地 */ }

        if (!localText && !cloudText) return null;
        if (!cloudText) { await this.push(localText!); return localText; }
        if (!localText || cloudSeen >= localSeen) return cloudText;
        await this.push(localText);
        return localText;
    }

    /** 节流补推由调用方驱动（离线攒批、关页 beacon 兜底在 H5 有、小游戏端用宿主 onHide） */
    async push(text: string): Promise<{ updatedAt: number } | null> {
        try {
            return await this.api.savePost(JSON.parse(text));
        } catch { return null; }
    }
}
