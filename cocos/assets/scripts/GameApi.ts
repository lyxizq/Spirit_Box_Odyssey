/**
 * GameApi · 服务端接入层（与 server/index.js 路由同口径）
 *
 * H5 版走 HttpOnly 会话 Cookie；微信/抖音小游戏无 cookie，登录后把返回的
 * sessionToken 注入 setSessionToken()，由 adapter 负责放进请求头。
 */
export interface LoginResult {
    ok: boolean;
    username?: string;
    sessionToken?: string;   // 小游戏端专用；H5 端为 undefined（Cookie 自动携带）
    error?: string;
}

export interface VersionInfo {
    version: string;
    time: number;
    tzOffset: number;
}

export class GameApi {
    private sessionToken: string | null = null;

    constructor(public baseUrl: string = 'http://127.0.0.1:8080') { }

    setSessionToken(token: string | null): void {
        this.sessionToken = token;
    }

    private async req<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
        const headers: Record<string, string> = {};
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        if (this.sessionToken) headers['x-session-token'] = this.sessionToken;
        const res = await fetch(this.baseUrl + path, {
            method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
            headers,
            credentials: 'include',          // H5：HttpOnly 会话 Cookie
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
        if (res.status === 401) throw new Error('未登录');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data as { error?: string }).error || ('HTTP ' + res.status));
        return data as T;
    }

    /** 断服探针：H5 版以约 2 分钟节拍连续 2 次失败挂横幅，同口径复用 */
    version(): Promise<VersionInfo> {
        return this.req<VersionInfo>('/api/version');
    }

    register(username: string, password: string): Promise<LoginResult> {
        return this.req<LoginResult>('/api/auth/register', { body: { username, password } });
    }

    login(username: string, password: string): Promise<LoginResult> {
        return this.req<LoginResult>('/api/auth/login', { body: { username, password } });
    }

    logout(): Promise<{ ok: boolean }> {
        return this.req<{ ok: boolean }>('/api/auth/logout', { body: {} });
    }

    me(): Promise<{ user: { username: string; display_name?: string } }> {
        return this.req('/api/auth/me');
    }

    saveGet(): Promise<unknown> {
        return this.req('/api/save');
    }

    savePost(state: unknown): Promise<{ ok: boolean; updatedAt: number }> {
        return this.req('/api/save', { body: state });
    }

    rank(): Promise<unknown> { return this.req('/api/rank'); }
    ladder(): Promise<unknown> { return this.req('/api/ladder'); }
    pvpFight(target: string): Promise<unknown> { return this.req('/api/pvp/fight', { body: { target } }); }
    bossHit(damage: number): Promise<unknown> { return this.req('/api/boss/hit', { body: { damage } }); }
    guildList(): Promise<unknown> { return this.req('/api/guild/list'); }
    redeem(code: string): Promise<unknown> { return this.req('/api/redeem', { body: { code } }); }
}
