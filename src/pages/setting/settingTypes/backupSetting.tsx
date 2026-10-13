import ListItem, { ListItemHeader } from "@/components/base/listItem";
import Backup from "@/core/backup";
import { ROUTE_PATH, useNavigate } from "@/core/router";
import Toast from "@/utils/toast";
import React from "react";
import { ScrollView, StyleSheet } from "react-native";

import { showDialog } from "@/components/dialogs/useDialog";
import { showPanel } from "@/components/panels/usePanel";
import axios from "axios";

import { ResumeMode } from "@/constants/commonConst.ts";
import Config, { useAppConfig } from "@/core/appConfig";
import { useI18N } from "@/core/i18n";
import delay from "@/utils/delay";
import { writeInChunks } from "@/utils/fileUtils.ts";
import { errorLog } from "@/utils/log.ts";
import { getDocumentAsync } from "expo-document-picker";
import { readAsStringAsync } from "expo-file-system";
import { AuthType, createClient } from "webdav";

export default function BackupSetting() {
    const { t } = useI18N();
    const navigate = useNavigate();

    const resumeMode = useAppConfig("backup.resumeMode");
    const webdavUrl = useAppConfig("webdav.url");
    const webdavUsername = useAppConfig("webdav.username");
    const webdavPassword = useAppConfig("webdav.password");


    const onBackupToLocal = async () => {
        navigate(ROUTE_PATH.FILE_SELECTOR, {
            fileType: "folder",
            multi: false,
            actionText: t("backupAndResume.beginBackup"),
            async onAction(selectedFiles) {
                const raw = Backup.backup();
                const folder = selectedFiles[0]?.path;
                return new Promise(resolve => {
                    showDialog("LoadingDialog", {
                        title: t("backupAndResume.backupDialogTitle"),
                        loadingText: t("backupAndResume.backuping"),
                        promise: writeInChunks(
                            `${folder}${folder?.endsWith("/") ? "" : "/"
                            }backup.json`,
                            raw,
                        ),
                        onResolve(_, hideDialog) {
                            Toast.success(t("toast.backupSuccess"));
                            hideDialog();
                            resolve(true);
                        },
                        onCancel(hideDialog) {
                            hideDialog();
                            resolve(false);
                        },
                        onReject(reason, hideDialog) {
                            hideDialog();
                            resolve(false);
                            console.log(reason);
                            Toast.warn(t("toast.backupFail", { reason: reason?.message ?? reason }));
                        },
                    });
                });
            },
        });
    };

    async function onResumeFromLocal() {
        try {
            const pickResult = await getDocumentAsync({
                copyToCacheDirectory: true,
                type: "application/json",
            });
            if (pickResult.canceled) {
                return;
            }
            const result = await readAsStringAsync(pickResult.assets[0].uri);
            return new Promise(resolve => {
                showDialog("LoadingDialog", {
                    title: t("backupAndResume.resumeFromLocalFile"),
                    loadingText: t("backupAndResume.resuming"),
                    async task() {
                        await delay(300, false);
                        return Backup.resume(result, resumeMode);
                    },
                    onResolve(_, hideDialog) {
                        Toast.success(t("toast.resumeSuccess"));
                        hideDialog();
                        resolve(true);
                    },
                    onCancel(hideDialog) {
                        hideDialog();
                        resolve(false);
                    },
                    onReject(reason, hideDialog) {
                        hideDialog();
                        resolve(false);
                        console.log(reason);
                        Toast.warn(t("toast.resumeFail", { reason: reason?.message ?? reason }));
                    },
                });
            });
        } catch (e: any) {
            errorLog("恢复失败", e);
            Toast.warn(t("toast.resumeFail", { reason: e?.message ?? e }));
        }
    }

    async function onResumeFromUrl() {
        showPanel("SimpleInput", {
            title: t("backupAndResume.resumeFromUrlDialogTitle"),
            placeholder: t("backupAndResume.resumeFromUrlDialogPlaceHolder"),
            maxLength: 1024,
            async onOk(text, closePanel) {
                try {
                    const url = text.trim();
                    if (url.endsWith(".json") || url.endsWith(".txt")) {
                        const raw = (await axios.get(text)).data;
                        await Backup.resume(raw, resumeMode);
                        Toast.success(t("toast.resumeSuccess"));
                        closePanel();
                    } else {
                        throw "无效的URL";
                    }
                } catch (e: any) {
                    Toast.warn(t("toast.resumeFail", { reason: e?.message ?? e }));
                }
            },
        });
    }

    async function onResumeKumoneFromWebdav() {
        const url = Config.getConfig("webdav.url");
        const username = Config.getConfig("webdav.username");
        const password = Config.getConfig("webdav.password");

        if (!(username && password && url)) {
            Toast.warn(t("toast.resumePreCheckFailed"));
            return;
        }
        const client = createClient(url, {
            authType: AuthType.Password,
            username: username,
            password: password,
        });

        // Kumone 把备份写成 KumoneBackup.json，但放在哪个目录因人而异，
        // 先把常见位置试一遍，再扫一层目录找同名文件。
        const candidates = [
            "/KumoneBackup.json",
            "/MusicFree/KumoneBackup.json",
            "/musicfree/KumoneBackup.json",
        ];
        let found: string | null = null;
        for (const candidate of candidates) {
            if (await client.exists(candidate)) {
                found = candidate;
                break;
            }
        }
        if (!found) {
            for (const dir of ["/", "/MusicFree"]) {
                try {
                    const contents = await client.getDirectoryContents(dir);
                    const hit = (contents ?? []).find(
                        it =>
                            it.type === "file" &&
                            it.basename?.toLowerCase() ===
                                "kumonebackup.json",
                    );
                    if (hit) {
                        found = hit.filename;
                        break;
                    }
                } catch {}
            }
        }
        if (!found) {
            Toast.warn(
                t("backupAndResume.kumoneBackupNotFound", {
                    paths: candidates.join(" / "),
                }),
            );
            return;
        }

        try {
            const resumeData = await client.getFileContents(found, {
                format: "text",
            });
            // Kumone 备份是「反复恢复」的场景：每次在 iOS 端重新导出都会再来一次。
            // 所以固定走按歌单名合并的模式，不沿用 MusicFree 备份的 resumeMode
            // （append 会每次都新建一份歌单）；曲目按 id+平台去重，重复恢复无害。
            await Backup.resume(resumeData, ResumeMode.Overwrite);
            Toast.success(t("toast.resumeSuccess"));
        } catch (e: any) {
            Toast.warn(t("toast.resumeFail", { reason: e?.message ?? e }));
        }
    }

    async function onResumeKumoneFromUrl() {
        showPanel("SimpleInput", {
            title: t("backupAndResume.resumeKumoneFromUrlDialogTitle"),
            placeholder: t(
                "backupAndResume.resumeKumoneFromUrlDialogPlaceHolder",
            ),
            maxLength: 1024,
            async onOk(text, closePanel) {
                try {
                    const target = text.trim();
                    if (
                        !(target.endsWith(".json") || target.endsWith(".txt"))
                    ) {
                        throw "无效的URL";
                    }
                    const raw = (await axios.get(target)).data;
                    // 同上：按歌单名合并，方便反复恢复同一份 Kumone 备份。
                    await Backup.resume(raw, ResumeMode.Overwrite);
                    Toast.success(t("toast.resumeSuccess"));
                    closePanel();
                } catch (e: any) {
                    Toast.warn(
                        t("toast.resumeFail", { reason: e?.message ?? e }),
                    );
                }
            },
        });
    }

    async function onResumeFromWebdav() {
        const url = Config.getConfig("webdav.url");
        const username = Config.getConfig("webdav.username");
        const password = Config.getConfig("webdav.password");

        if (!(username && password && url)) {
            Toast.warn(t("toast.resumePreCheckFailed"));
            return;
        }
        const client = createClient(url, {
            authType: AuthType.Password,
            username: username,
            password: password,
        });

        if (!(await client.exists("/MusicFree/MusicFreeBackup.json"))) {
            Toast.warn(t("toast.backupFileNotFound"));
            return;
        }

        try {
            const resumeData = await client.getFileContents(
                "/MusicFree/MusicFreeBackup.json",
                {
                    format: "text",
                },
            );
            await Backup.resume(
                resumeData,
                Config.getConfig("backup.resumeMode"),
            );
            Toast.success(t("toast.resumeSuccess"));
        } catch (e: any) {
            Toast.warn(t("toast.resumeFail", { reason: e?.message ?? e }));
        }
    }

    async function onBackupToWebdav() {
        const username = Config.getConfig("webdav.username");
        const password = Config.getConfig("webdav.password");
        const url = Config.getConfig("webdav.url");
        if (!(username && password && url)) {
            Toast.warn(t("toast.resumePreCheckFailed"));
            return;
        }
        try {
            const client = createClient(url, {
                authType: AuthType.Password,
                username: username,
                password: password,
            });

            const raw = Backup.backup();
            if (!(await client.exists("/MusicFree"))) {
                await client.createDirectory("/MusicFree");
            }
            // 临时文件
            await client.putFileContents(
                "/MusicFree/MusicFreeBackup.json",
                raw,
                {
                    overwrite: true,
                },
            );
            Toast.success(t("toast.backupSuccess"));
        } catch (e: any) {
            Toast.warn(t("toast.backupFail", { reason: e?.message ?? e }));
        }
    }

    return (
        <ScrollView style={style.wrapper}>
            <ListItemHeader>{t("sidebar.backupAndResume")}</ListItemHeader>

            <ListItem
                withHorizontalPadding
                onPress={() => {
                    showDialog("RadioDialog", {
                        title: t("backupAndResume.setResumeMode"),
                        content: [
                            {
                                label: t(("backupAndResume.resumeMode." + ResumeMode.Append) as any),
                                value: ResumeMode.Append,
                            },
                            {
                                label: t(("backupAndResume.resumeMode." + ResumeMode.OverwriteDefault) as any),
                                value: ResumeMode.OverwriteDefault,
                            },
                            {
                                label: t(("backupAndResume.resumeMode." + ResumeMode.Overwrite) as any),
                                value: ResumeMode.Overwrite,
                            },
                        ],
                        onOk(value) {
                            Config.setConfig(
                                "backup.resumeMode",
                                value as any,
                            );
                        },
                    });
                }}>
                <ListItem.Content title={t("backupAndResume.resumeMode")} />
                <ListItem.ListItemText>
                    {
                        t(("backupAndResume.resumeMode." + ((resumeMode as ResumeMode) ||
                            ResumeMode.Append)) as any)
                    }
                </ListItem.ListItemText>
            </ListItem>
            <ListItemHeader>{t("backupAndResume.localBackup")}</ListItemHeader>
            <ListItem withHorizontalPadding onPress={onBackupToLocal}>
                <ListItem.Content title={t("backupAndResume.backupToLocal")} />
            </ListItem>
            <ListItem withHorizontalPadding onPress={onResumeFromLocal}>
                <ListItem.Content title={t("backupAndResume.resumeFromLocalFile")} />
            </ListItem>
            <ListItem withHorizontalPadding onPress={onResumeFromUrl}>
                <ListItem.Content title={t("backupAndResume.resumeFromUrlDialogTitle")} />
            </ListItem>
            <ListItemHeader>Webdav</ListItemHeader>
            <ListItem
                withHorizontalPadding
                onPress={() => {
                    showPanel("SetUserVariables", {
                        title: t("backupAndResume.webdavSettings"),
                        initValues: {
                            url: webdavUrl ?? "",
                            username: webdavUsername ?? "",
                            password: webdavPassword ?? "",
                        },
                        variables: [
                            {
                                key: "url",
                                name: "URL",
                                hint: t("backupAndResume.webdavUrl"),
                            },
                            {
                                key: "username",
                                name: t("common.username"),
                            },
                            {
                                key: "password",
                                name: t("common.password"),
                            },
                        ],
                        onOk(values, closePanel) {
                            Config.setConfig("webdav.url", values?.url);
                            Config.setConfig("webdav.username", values?.username);
                            Config.setConfig("webdav.password", values?.password);

                            Toast.success(t("toast.saveSuccess"));
                            closePanel();
                        },
                    });
                }}>
                <ListItem.Content title={t("backupAndResume.webdavSettings")} />
            </ListItem>
            <ListItem withHorizontalPadding onPress={onBackupToWebdav}>
                <ListItem.Content title={t("backupAndResume.backupToWebdav")} />
            </ListItem>
            <ListItem withHorizontalPadding onPress={onResumeFromWebdav}>
                <ListItem.Content title={t("backupAndResume.resumeFromWebdav")} />
            </ListItem>
            <ListItemHeader>Kumone 备份</ListItemHeader>
            <ListItem withHorizontalPadding onPress={onResumeKumoneFromWebdav}>
                <ListItem.Content title={t("backupAndResume.resumeKumoneFromWebdav")} />
            </ListItem>
            <ListItem withHorizontalPadding onPress={onResumeKumoneFromUrl}>
                <ListItem.Content title={t("backupAndResume.resumeKumoneFromUrl")} />
            </ListItem>
        </ScrollView>
    );
}

const style = StyleSheet.create({
    wrapper: {
        width: "100%",
        flex: 1,
    },
});
