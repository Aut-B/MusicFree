/** 备份与恢复 */
/** 歌单、插件 */
import { compare } from "compare-versions";
import PluginManager from "./pluginManager";
import MusicSheet from "@/core/musicSheet";
import { ResumeMode } from "@/constants/commonConst.ts";

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
            platform: "网易云",
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
        if (
            validPlugins.find(
                plugin =>
                    plugin.instance.srcUrl === _.srcUrl &&
                    compare(
                        plugin.instance.version ?? "0.0.0",
                        _.version ?? "0.0.1",
                        ">=",
                    ),
            )
        ) {
            return;
        }
        return PluginManager.installPluginFromUrl(_.srcUrl);
    });

    /** 恢复歌单（Kumone 备份的 mixedSheets 一视同仁） */
    const allSheets: IMusic.IMusicSheetItem[] = [
        ...(Array.isArray(musicSheets) ? musicSheets : []),
        ...(Array.isArray(mixedSheets) ? mixedSheets : []),
    ];
    if (!allSheets.length && !plugins?.length) {
        throw new Error("备份文件格式无效");
    }
    const normalizedSheets = allSheets.map(sheet => ({
        ...sheet,
        musicList: (sheet?.musicList ?? [])
            .map(normalizeKumoneMusicItem)
            .filter(Boolean),
    }));
    const resumeMusicSheets = MusicSheet.resumeSheets(
        normalizedSheets as IMusic.IMusicSheetItem[],
        resumeMode,
    );

    return Promise.all([...(resumePlugins ?? []), resumeMusicSheets]);
}

const Backup = {
    backup,
    resume,
};
export default Backup;
