import { type I18n, i18n } from "@lingui/core";
export type Translate = I18n["_"];
export const defaultTranslate: Translate = i18n._.bind(i18n);
/** Backend messages are marked at their source, including inside each plugin. */
export function remoteText(
  value: string,
  translate: Translate = defaultTranslate,
): string {
  const status = /^节点请求失败（HTTP (\d+)）$/.exec(value)?.[1];
  if (status)
    return translate(
      /*i18n*/
      {
        id: "节点请求失败（HTTP {status}）",
        message: "节点请求失败（HTTP {status}）",
        values: {
          status,
        },
      },
    );
  return i18n.messages[value] ? translate(value) : value;
}
