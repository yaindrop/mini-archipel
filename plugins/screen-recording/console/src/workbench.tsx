import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Empty,
  Flex,
  Form,
  InputNumber,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { Link, useSearchParams } from "react-router";
import type { Host } from "../../../../console/src/contracts.ts";
import type { WorkspaceProps } from "../../../../console/src/web/plugins.tsx";
import { displayName, formatBytes } from "../../../../console/src/domain.ts";
import {
  NodePager,
  PageTitle,
  Section,
} from "../../../../console/src/web/ui.tsx";
import { api, message } from "../../../../console/src/web/api.ts";
import { refreshArchipel } from "../../../../console/src/web/useArchipel.ts";
import {
  ArtifactSchema,
  ReplySchema,
  type RecorderReply,
} from "./contracts.ts";
import { recorderCurrent, recorderData, recordingId } from "./domain.ts";

import { PermissionChecks } from "../../../../console/src/web/permission-checks.tsx";

export function ScreenRecorder({ archipel, now }: WorkspaceProps) {
  const { t } = useLingui(),
    [search, setSearch] = useSearchParams();
  const host =
    archipel.hosts.find((h) => h.name === search.get("host")) ??
    archipel.hosts[0];
  return (
    <>
      <PageTitle
        title={t`屏幕录制`}
        description={t`录制节点上的屏幕或指定窗口，原视频与鼠标轨道分别保存。`}
      />
      <NodePager
        hosts={archipel.hosts}
        now={now}
        selected={host?.name}
        onSelect={(name) => {
          setSearch({ host: name }, { replace: true });
        }}
        label={(h) => t`选择 ${displayName(h)}`}
        primary={(h) => recorderData(h)?.recorder?.state ?? "—"}
        secondary={(h) =>
          recorderData(h)?.availability === "ready"
            ? t`伴随应用已安装`
            : t`伴随应用未就绪`
        }
      />
      {host ? (
        <Recorder key={host.name} host={host} now={now} />
      ) : (
        <Empty description={t`没有可用节点`} />
      )}
    </>
  );
}
function Recorder({ host, now }: { host: Host; now: number }) {
  const { t } = useLingui(),
    client = useQueryClient(),
    data = recorderData(host);
  const current = recorderCurrent(host, now),
    control = current && Boolean(data?.control_allowed),
    ready = ["ready", "error"].includes(data?.availability ?? "");
  const [id, setId] = useState(() => crypto.randomUUID()),
    [mode, setMode] = useState<"window" | "display">("window"),
    [target, setTarget] = useState<number>();
  const [duration, setDuration] = useState(18),
    [tail, setTail] = useState(1),
    [pointer, setPointer] = useState(false),
    [backup, setBackup] = useState<string>();
  const [windows, setWindows] = useState<{ value: number; label: string }[]>(
      [],
    ),
    [displays, setDisplays] = useState<{ value: number; label: string }[]>([]);
  const [preview, setPreview] = useState<string>(),
    [result, setResult] = useState<RecorderReply>();
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const call = useMutation({
    retry: false,
    mutationFn: ({
      action,
      fields = {},
    }: {
      action: string;
      fields?: Record<string, unknown>;
    }) =>
      api.pluginAction(
        "screen-recording",
        action,
        { host: host.name, ...fields },
        ReplySchema,
      ),
    onSuccess: (reply) => {
      setResult(reply);
      if (reply.windows)
        setWindows(
          reply.windows.map((w) => ({
            value: w.id,
            label: `${w.title || String(w.id)} · ${w.bundleID}`,
          })),
        );
      if (reply.displays)
        setDisplays(
          reply.displays.map((d) => ({
            value: d.id,
            label: `${String(d.id)} · ${String(d.width)} × ${String(d.height)}`,
          })),
        );
      void refreshArchipel(client);
    },
  });
  const action = (name: string, fields?: Record<string, unknown>) => {
    call.mutate({ action: name, ...(fields ? { fields } : {}) });
  };
  const download = useMutation({
    retry: false,
    mutationFn: async ({
      kind,
      save,
    }: {
      kind: "video" | "pointer";
      save: boolean;
    }) => {
      const recording = recordingId(data?.recorder?.output);
      if (!recording)
        throw Error(t`此文件来自其他录制入口，请使用节点上的文件路径。`);
      const parts: Uint8Array<ArrayBuffer>[] = [],
        limit = 128 * 1024 * 1024;
      let offset = 0,
        name = "",
        mime = "";
      do {
        const chunk = await api.pluginAction(
          "screen-recording",
          "artifact",
          { host: host.name, recording_id: recording, kind, offset },
          ArtifactSchema,
        );
        if (
          chunk.total_bytes > limit ||
          chunk.offset !== offset ||
          chunk.next_offset <= offset ||
          chunk.next_offset > chunk.total_bytes
        )
          throw Error(t`文件过大或分片已变化，请使用节点上的原文件。`);
        const bytes = new Uint8Array(chunk.data.length / 2);
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = parseInt(chunk.data.slice(i * 2, i * 2 + 2), 16);
        if (chunk.next_offset - offset !== bytes.length)
          throw Error(t`录制文件分片不完整`);
        parts.push(bytes);
        offset = chunk.next_offset;
        name = chunk.name;
        mime = chunk.mime;
        if (offset === chunk.total_bytes) break;
      } while (offset < limit);
      return {
        url: URL.createObjectURL(new Blob(parts, { type: mime })),
        name,
        save,
      };
    },
    onSuccess: ({ url, name, save }) => {
      if (save) {
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 1000);
      } else setPreview(url);
    },
  });
  const state = data?.recorder?.state;
  const active = ["recording", "stopping", "processing"].includes(state ?? "");
  const stateText =
    state === "recording"
      ? t`录制中`
      : state === "stopping"
        ? t`正在收尾`
        : state === "processing"
          ? t`处理中`
          : state === "completed"
            ? t`已完成`
            : state === "failed"
              ? t`失败`
              : t`待机`;
  const error = call.error ?? download.error;
  const installedName = data?.recorder?.appName ?? t`群岛插件：屏幕录制`;
  return (
    <div className="recorder-workspace">
      {!current && <Alert type="warning" title={t`节点或录屏插件未就绪`} />}
      {data?.availability === "unsupported" && (
        <Alert type="info" title={t`此节点不支持屏幕录制`} />
      )}
      {data && !data.control_allowed && (
        <Alert type="info" title={t`节点尚未启用录屏控制`} />
      )}
      <Section title={t`环境与权限`}>
        <Descriptions
          size="small"
          column={1}
          items={[
            { key: "app", label: t`伴随应用`, children: installedName },
            {
              key: "path",
              label: t`应用路径`,
              children: (
                <Typography.Text copyable>
                  {data?.recorder?.appPath ?? "—"}
                </Typography.Text>
              ),
            },
            { key: "state", label: t`状态`, children: <Tag>{stateText}</Tag> },
          ]}
        />
        <PermissionChecks
          node={displayName(host)}
          items={[
            {
              key: "screen",
              label: t`屏幕录制`,
              status: data?.permissions.screen.status ?? "unchecked",
              checkedAt: data?.permissions.screen.checked_at,
              detail: data?.permissions.screen.message,
              canCheck: current && ready && !call.isPending,
              canRequest: control && ready && !call.isPending && !active,
              busy: call.isPending,
              onCheck: () => {
                action("doctor");
              },
              onRequest: () => {
                action("authorize", { interactive: true });
              },
            },
            ...(pointer
              ? [
                  {
                    key: "input",
                    label: t`输入监控（鼠标轨道）`,
                    status: data?.permissions.input.status ?? "unchecked",
                    checkedAt: data?.permissions.input.checked_at,
                    detail: data?.permissions.input.message,
                    canCheck: current && ready && !call.isPending,
                    canRequest: control && ready && !call.isPending && !active,
                    busy: call.isPending,
                    onCheck: () => {
                      action("pointer-doctor");
                    },
                    onRequest: () => {
                      action("pointer-authorize", { interactive: true });
                    },
                  },
                ]
              : []),
          ]}
        />
        <Button
          disabled={!current || !ready || call.isPending}
          onClick={() => {
            action("status");
          }}
        >{t`刷新状态`}</Button>
        <Typography.Paragraph type="secondary">{t`静默检查不会申请权限。只有明确授权操作才在所选节点打开系统界面；普通录屏不需要输入监控。`}</Typography.Paragraph>
        {data?.error && <Alert type="error" title={data.error} />}
      </Section>
      <div className="recorder-columns">
        <Section title={t`录制设置`}>
          <Form
            layout="vertical"
            disabled={!control || !ready || call.isPending || active}
            onFinish={() => {
              action("start", {
                request: {
                  request_id: id,
                  duration,
                  tail,
                  ...(mode === "window"
                    ? { window: target }
                    : target
                      ? { display: target }
                      : {}),
                  ...(pointer ? { pointer_source: "native" } : {}),
                },
              });
            }}
          >
            <Form.Item label={t`录制范围`}>
              <Select
                aria-label={t`录制范围`}
                value={mode}
                onChange={(value) => {
                  setMode(value);
                  setTarget(undefined);
                }}
                options={[
                  { value: "window", label: t`指定窗口` },
                  { value: "display", label: t`屏幕` },
                ]}
              />
            </Form.Item>
            <Form.Item label={t`目标`}>
              <Space.Compact className="recorder-target">
                <Select
                  aria-label={t`录制目标`}
                  value={target}
                  onChange={setTarget}
                  options={
                    mode === "window"
                      ? windows
                      : [{ label: t`主屏幕`, value: 0 }, ...displays]
                  }
                  placeholder={
                    mode === "window" ? t`请刷新并选择窗口` : t`主屏幕`
                  }
                />
                <Button
                  onClick={() => {
                    action(mode === "window" ? "windows" : "displays");
                  }}
                >{t`刷新目标`}</Button>
              </Space.Compact>
            </Form.Item>
            <div className="recorder-timing">
              <Form.Item label={t`录制秒数`}>
                <InputNumber
                  aria-label={t`录制秒数`}
                  value={duration}
                  min={1}
                  max={86400}
                  onChange={(value) => {
                    if (value != null) setDuration(value);
                  }}
                />
              </Form.Item>
              <Form.Item label={t`静止尾段秒数`}>
                <InputNumber
                  aria-label={t`静止尾段秒数`}
                  value={tail}
                  min={0}
                  max={30}
                  onChange={(value) => {
                    if (value != null) setTail(value);
                  }}
                />
              </Form.Item>
            </div>
            <Form.Item>
              <Checkbox
                checked={pointer}
                onChange={(e) => {
                  setPointer(e.target.checked);
                }}
              >{t`单独保存真实鼠标轨道`}</Checkbox>
            </Form.Item>
            <Typography.Paragraph type="secondary">{t`视频保留原生指针，不烘焙光效。鼠标轨道可另行编辑、改色或关闭效果。`}</Typography.Paragraph>
            <Space wrap>
              <Button
                type="primary"
                htmlType="submit"
                loading={call.isPending}
                disabled={
                  !control || !ready || active || (mode === "window" && !target)
                }
              >{t`开始录制`}</Button>
              <Button
                onClick={() => {
                  setId(crypto.randomUUID());
                  setResult(undefined);
                }}
              >{t`新建录制`}</Button>
            </Space>
          </Form>
          <Flex className="recorder-stop" gap="small" wrap>
            <Button
              danger
              disabled={!control || state !== "recording" || call.isPending}
              loading={state === "stopping"}
              onClick={() => {
                action("stop");
              }}
            >{t`停止并保存`}</Button>
          </Flex>
          <Typography.Paragraph type="secondary">{t`停止后仍需等待收尾。关闭插件不会停止已接受的录制；超时请先查状态，不要用新编号重复启动。`}</Typography.Paragraph>
          <Typography.Paragraph copyable>{id}</Typography.Paragraph>
        </Section>
        <Section title={t`最近录制与结果`}>
          {state === "completed" ? (
            <>
              <Descriptions
                size="small"
                column={1}
                items={[
                  {
                    key: "duration",
                    label: t`时长`,
                    children: `${String(data?.recorder?.durationSeconds ?? 0)} s`,
                  },
                  {
                    key: "size",
                    label: t`文件大小`,
                    children: formatBytes(data?.recorder?.bytes ?? 0),
                  },
                  {
                    key: "file",
                    label: t`录制文件`,
                    children: (
                      <Typography.Text copyable>
                        {data?.recorder?.output}
                      </Typography.Text>
                    ),
                  },
                  {
                    key: "pointer",
                    label: t`鼠标轨道`,
                    children: (
                      <Typography.Text copyable>
                        {data?.recorder?.pointerOutput ?? "—"}
                      </Typography.Text>
                    ),
                  },
                ]}
              />
              <Space wrap>
                <Button
                  disabled={!recordingId(data?.recorder?.output)}
                  loading={download.isPending}
                  onClick={() => {
                    download.mutate({ kind: "video", save: false });
                  }}
                >{t`预览录像`}</Button>
                <Button
                  disabled={!recordingId(data?.recorder?.output)}
                  onClick={() => {
                    download.mutate({ kind: "video", save: true });
                  }}
                >{t`下载录像`}</Button>
                <Button
                  disabled={
                    !recordingId(data?.recorder?.output) ||
                    !data?.recorder?.pointerOutput
                  }
                  onClick={() => {
                    download.mutate({ kind: "pointer", save: true });
                  }}
                >{t`下载鼠标轨道`}</Button>
              </Space>
            </>
          ) : (
            <Empty
              description={active ? t`正在等待录制完成` : t`尚无已完成的录制`}
            />
          )}
          {preview && (
            <video
              className="recorder-preview"
              controls
              muted
              src={preview}
              aria-label={t`录制预览`}
            />
          )}
          {result && (
            <Alert
              className="recorder-feedback"
              type={result.ok ? "success" : "error"}
              title={result.code}
              description={result.message}
            />
          )}
          {error && (
            <Alert
              className="recorder-feedback"
              type="error"
              title={message(error)}
            />
          )}
        </Section>
      </div>
      <Section title={t`安装与回退`}>
        <Typography.Paragraph type="secondary">{t`使用节点已部署的固定安装包。升级前必须结束录制；旧应用、技术入口和数据保留回退，授权继承以真实检查为准。`}</Typography.Paragraph>
        {!data?.package_available && (
          <Alert type="info" title={t`请先在节点部署伴随应用安装包`} />
        )}
        <Space wrap>
          <Button
            disabled={
              !control || !data?.package_available || active || call.isPending
            }
            onClick={() => {
              action(ready ? "upgrade" : "install");
            }}
          >
            {ready ? t`升级伴随应用` : t`安装伴随应用`}
          </Button>
          <Select
            aria-label={t`回退版本`}
            className="recorder-backup"
            value={backup ?? data?.backups[0] ?? null}
            onChange={setBackup}
            options={(data?.backups ?? []).map((path) => ({
              value: path,
              label: path.split("/").at(-1) ?? path,
            }))}
            placeholder={t`选择已有备份`}
          />
          <Button
            disabled={
              !control ||
              !data?.package_available ||
              active ||
              call.isPending ||
              !(backup ?? data.backups[0])
            }
            onClick={() => {
              action("rollback", { backup: backup ?? data?.backups[0] });
            }}
          >{t`回退伴随应用`}</Button>
        </Space>
      </Section>
    </div>
  );
}
export function NodePanel({ host }: WorkspaceProps & { host: Host }) {
  const { t } = useLingui(),
    data = recorderData(host);
  return (
    <Section title={t`屏幕录制`}>
      <Flex justify="space-between" gap="small" wrap>
        <span>
          {data?.recorder?.state === "recording"
            ? t`录制中`
            : data?.availability === "ready"
              ? t`伴随应用已安装`
              : t`伴随应用未就绪`}
        </span>
        <Link
          to={`/screen-recording?host=${encodeURIComponent(host.name)}`}
        >{t`管理录制`}</Link>
      </Flex>
    </Section>
  );
}
