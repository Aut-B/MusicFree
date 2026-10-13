/**
 * compare-versions 的入参清洗。
 *
 * 那个库只认 semver，遇到空串、undefined、日期串（"2025-10-13"）、带比较符的
 * （">0.4.0"）都会直接 throw。而恢复备份时版本号来自两个都不可控的地方：备份
 * 文件里写的版本，以及插件自己 module.exports 声明的版本。任何一边是脏的，整份
 * 恢复都会崩在这个 compare 上——表现为「第一次恢复成功，第二次就失败」。
 *
 * 这里统一退回 "0.0.0"，语义上也说得通：不知道版本就当最旧，该装装、该跳跳。
 */
export default function safeVersion(version: unknown): string {
    if (typeof version !== "string") {
        return "0.0.0";
    }
    const trimmed = version.trim().replace(/^v/i, "");
    return /^\d+(\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)
        ? trimmed
        : "0.0.0";
}
