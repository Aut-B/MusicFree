/** 备份与恢复 */
/** 歌单、插件 */
import { compare } from "compare-versions";
import PluginManager from "./pluginManager";
import MusicSheet from "@/core/musicSheet";
import { ResumeMode } from "@/constants/commonConst.ts";
import safeVersion from "@/utils/safeVersion";

/**
 * 结果：一份大的json文件
 * {
 *     musicSheets: [],
 *     plugins: [],
 * }
 *
 * 同时兼容 Kumone（iOS 上的 MusicFree 插件版）导出的 KumoneBackup.json：
 * 结构相同，只是单曲字段需要 normalizeKumoneMusicItem 转一道；
 * 旧版 Kumone 还有一份 mixedSheets，一并恢复。
 */

interface IBackJson {
    musicSheets: IMusic.IMusicSheetItem[];
    /** 旧版 Kumone 的混装歌单，结构与 musicSheets 相同 */
    mixedSheets?: IMusic.IMusicSheetItem[];
    plugins: Array<{ srcUrl: string; version: string }>;
}

/**
 * 把 Kumone（iOS 上的 MusicFree 插件版）备份里的单条音乐转成 MusicFree 的
 * IMusicItem。
 *
 * KumoneBackup.json 与 MusicFree 备份同形——{ musicSheets: [{title, musicList}],
 * plugins: [] }——但 musicList 里的条目有两处不一样：
 *   1. 网易云歌曲是「引用条目」：{ kind: "netease", id: <int>, name, artist,
 *      album, durationMS, picUrl }。MusicFree 需要 id 为字符串、标题叫 title、
 *     封面叫 artwork、时长以秒计；
 *   2. 插件曲是插件的原始 JSON 外加一个 kind 标记，字段本身是兼容的，原样
 *      带上即可（url / source 等播放要用的信息都藏在里面）。
 *
 * MusicFree 自己的备份条目也走这个函数：字段本来就齐，等价于原样返回。
 */
function normalizeKumoneMusicItem(
    raw: any,
    neteasePlatform: string = "网易云",
): IMusic.IMusicItem | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    if (raw.kind === "netease") {
        if (raw.id === undefined || raw.id === null || raw.id === "") {
            return null;
        }
        return {
            id: String(raw.id),
            platform: neteasePlatform,
            title: raw.name ?? raw.title ?? "",
            artist: raw.artist ?? "",
            album: raw.album ?? "",
            artwork: raw.picUrl ?? raw.artwork ?? "",
            duration: Number(raw.durationMS ?? raw.duration ?? 0) / 1000,
        };
    }
    if (raw.id === undefined || raw.id === null || raw.id === "") {
        return null;
    }
    const item: any = { ...raw };
    delete item.kind;
    const durationMS =
        typeof item.durationMS === "number" ? item.durationMS : undefined;
    return {
        ...item,
        id: String(item.id),
        platform: item.platform ?? "",
        title: item.title ?? item.name ?? "",
        artist: item.artist ?? "",
        album: item.album ?? "",
        artwork: item.artwork ?? item.picUrl ?? "",
        duration:
            typeof item.duration === "number"
                ? item.duration
                : durationMS !== undefined
                  ? durationMS / 1000
                  : 0,
    };
}

/**
 * 网易云在 MusicFree 里同样是插件，播放时靠 platform 名路由到插件
 * （getByName(mediaItem.platform)），名字必须和插件声明的一字不差——
 * 「网易云」≠「网易云音乐」。社区里主流的那份叫「网易云」，但也有分支叫
 * 「网易云音乐」；装完插件后按实际装上的那个取名，取不到再退回默认值。
 */
function detectNeteasePlatform(): string {
    const installed = PluginManager.getEnabledPlugins() ?? [];
    const hits = installed
        .map(_ => _?.instance?.platform)
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .filter(p => /网易云|netease/i.test(p));
    if (!hits.length) {
        return "网易云";
    }
    // 同时装着多个网易云系插件时优先用标准名，免得同一首歌被拆成两份
    return hits.includes("网易云") ? "网易云" : hits[0];
}

/**
 * 把同名歌单并成一份。
 *
 * Kumone 的备份是「本地歌单 + 网易云歌单」直接拼的，两边重名就会出现两条同标题
 * 条目。MusicFree 的 Overwrite 合并在开循环前一次性建 title→id 映射，循环里新建
 * 的歌单不进映射，于是同标题的每条各建一份——恢复一次，同名歌单就翻一倍。
 */
function mergeSheetsByTitle(
    sheets: IMusic.IMusicSheetItem[],
): IMusic.IMusicSheetItem[] {
    const order: IMusic.IMusicSheetItem[] = [];
    const byTitle = new Map<string, IMusic.IMusicSheetItem>();
    for (const sheet of sheets) {
        const title = sheet?.title ?? "";
        const existing = byTitle.get(title);
        if (existing) {
            existing.musicList = [
                ...(existing.musicList ?? []),
                ...(sheet?.musicList ?? []),
            ];
            continue;
        }
        const copy = {
            ...sheet,
            musicList: [...(sheet?.musicList ?? [])],
        } as IMusic.IMusicSheetItem;
        byTitle.set(title, copy);
        order.push(copy);
    }
    return order;
}

function backup() {
    const musicSheets = MusicSheet.backupSheets();
    const plugins = PluginManager.getEnabledPlugins();
    const normalizedPlugins = plugins.map(_ => ({
        srcUrl: _.instance.srcUrl,
        version: _.instance.version,
    }));

    return JSON.stringify({
        musicSheets: musicSheets,
        plugins: normalizedPlugins,
    });
}

async function resume(
    raw: string | Object,
    resumeMode: ResumeMode = ResumeMode.Append,
) {
    let obj: IBackJson;
    if (typeof raw === "string") {
        try {
            obj = JSON.parse(raw);
        } catch {
            throw new Error("备份文件格式无效");
        }
    } else {
        obj = raw as IBackJson;
    }

    const { plugins, musicSheets, mixedSheets } = obj ?? {};
    /** 恢复插件 */
    const validPlugins = PluginManager.getEnabledPlugins();
    const resumePlugins = plugins?.map(_ => {
        // 校验是否安装过: 同源且本地版本更高就忽略掉
        // 版本号两边都要过 safeVersion：compare-versions 只认 semver，空串、
        // 日期串、undefined 都会让它 throw，把整份恢复带崩。
        if (
            validPlugins.find(
                plugin =>
                    plugin.instance.srcUrl === _.srcUrl &&
                    compare(
                        safeVersion(plugin.instance.version),
                        safeVersion(_.version),
                        ">=",
                    ),
            )
        ) {
            return;
        }
        // 单个插件地址失效不该拖垮整份恢复：歌单里大部分是别的音源，
        // 为了一个 404 把全部歌单都回滚不划算。失败只记日志。
        return PluginManager.installPluginFromUrl(_.srcUrl).catch(e => {
            console.warn(`[resume] 插件安装失败：${_.srcUrl}`, e);
        });
    });

    /** 恢复歌单（Kumone 备份的 mixedSheets 一视同仁） */
    const rawSheets: IMusic.IMusicSheetItem[] = [
        ...(Array.isArray(musicSheets) ? musicSheets : []),
        ...(Array.isArray(mixedSheets) ? mixedSheets : []),
    ];
    const allSheets = mergeSheetsByTitle(rawSheets);
    if (!allSheets.length && !plugins?.length) {
        throw new Error("备份文件格式无效");
    }
    // 先等插件装完：网易云曲的 platform 要按实际装上的那个插件取名，
    // 装完再归一化才拿得到名字。
    await Promise.all(resumePlugins ?? []);
    const neteasePlatform = detectNeteasePlatform();
    const normalizedSheets = allSheets.map(sheet => ({
        ...sheet,
        musicList: (sheet?.musicList ?? [])
            .map(item => normalizeKumoneMusicItem(item, neteasePlatform))
            .filter(Boolean),
    }));
    return MusicSheet.resumeSheets(
        normalizedSheets as IMusic.IMusicSheetItem[],
        resumeMode,
    );
}

const Backup = {
    backup,
    resume,
};
export default Backup;
