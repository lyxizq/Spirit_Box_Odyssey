/**
 * Main · 启动装配最小闭环示例：探针 → 登录态 → 存档恢复 →（挂到你的场景根节点）
 *
 * Creator 3.8：把本组件挂到启动场景任意节点，面板里配 baseUrl。正式玩法场景
 * （开匣/征战/闲趣三页）在 H5 版驱动，本脚手架只打通「连上服务端 + 存档可达」。
 */
import { _decorator, Component } from 'cc';
import { GameApi } from './GameApi';
import { SaveAdapter } from './SaveAdapter';

const { ccclass, property } = _decorator;

@ccclass('Main')
export class Main extends Component {

    @property
    baseUrl = 'http://127.0.0.1:8080';

    api!: GameApi;
    saves!: SaveAdapter;

    async start() {
        this.api = new GameApi(this.baseUrl);
        this.saves = new SaveAdapter(this.api);

        try {
            const v = await this.api.version();
            console.log('[lingxia] 服务端就绪 v' + v.version);
        } catch {
            console.warn('[lingxia] 服务端不可达：进入离线模式，进度仅存本机');
        }

        try {
            const me = await this.api.me();
            console.log('[lingxia] 已登录：' + me.user.username);
            const save = await this.saves.syncOnBoot();
            console.log('[lingxia] 存档恢复' + (save ? '成功（' + save.length + ' 字节）' : '：新档'));
        } catch {
            console.log('[lingxia] 未登录：走 login 场景（GameApi.register/login）');
        }
    }
}
