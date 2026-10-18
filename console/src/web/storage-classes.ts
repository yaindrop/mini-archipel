import { msg } from "@lingui/core/macro";
export const CLASSES: Record<
  string,
  {
    label: import("@lingui/core").MessageDescriptor;
    color: string;
  }
> = {
  get system() {
    return {
      label: msg`系统`,
      color: "#7e91a5",
    };
  },
  get apps() {
    return {
      label: msg`应用`,
      color: "#4b9f89",
    };
  },
  get user() {
    return {
      label: msg`用户数据`,
      color: "#5b82cd",
    };
  },
  get reclaimable() {
    return {
      label: msg`可重建缓存`,
      color: "#c19340",
    };
  },
  get toolchain() {
    return {
      label: msg`工具链`,
      color: "#a27bc6",
    };
  },
  get agentic() {
    return {
      label: msg`AI 工具`,
      color: "#c47a66",
    };
  },
  get appdata() {
    return { label: msg`应用数据`, color: "#7197ad" };
  },
  get library() {
    return {
      label: msg`资料库`,
      color: "#7197ad",
    };
  },
};
export function classification(key: string) {
  return (
    CLASSES[key] ?? {
      label: msg`其他`,
      color: "#8b97a7",
    }
  );
}
