# 上游来源说明 / Upstream Notice

> 本仓库**不是**原项目，而是第三方只读备份镜像。
> This repository is **NOT** the original project. It is a third-party read-only backup mirror.

## 上游信息 / Upstream

| 项目 | 值 |
| --- | --- |
| 上游仓库 | <https://github.com/Ebony-Vinyl/dsh-our-free-model> |
| 上游作者 | [Ebony-Vinyl](https://github.com/Ebony-Vinyl) |
| 上游默认分支 | `main` |
| 备份时上游 HEAD | `f8974369c5904858c696b520d8b9b82ad4425f78` |
| 备份时上游 HEAD 时间 | 2026-10-09 15:16:27 UTC |
| 许可证 | MIT（见 [LICENSE](LICENSE)，Copyright (c) 2026 Ebony-Vinyl） |

## 本仓库的用途 / Purpose

- 仅作**备份 / 存档**，不参与开发，不接受上游之外的改动。
- 所有代码、文档、许可证、提交历史的版权与署名均归上游作者所有。
- 本项目自身的功能说明、安装方式、使用文档，请以**上游仓库**为准。

## 备份范围 / Scope

| 类型 | 数量 | 说明 |
| --- | --- | --- |
| 分支 | 8 | 与上游分支名一一对应 |
| 标签 | 11 | `v1.1.2` … `v2.0.0` |
| 提交 | 396 | 完整历史（`git rev-list --all`） |

已备份分支：

```
main
docs/trending-rankings-20261006
feat/2.0-channel-pack-and-kilo
feat/eac-exo-local
fix/announcement-enforcement
fix/image-tool-login-races
release/v1.3.2
trae/agent-11iWzm
```

已备份标签：

```
v1.1.2  v1.2.2  v1.3.0  v1.3.1  v1.3.2
v1.4.2  v1.4.3  v1.4.4  v1.4.5  v1.4.6  v2.0.0
```

未备份内容：上游的 `refs/pull/*`（GitHub 的隐藏 PR 引用，无法通过 push 复制）。

## 与上游的差异 / Divergence

除本说明文件（`UPSTREAM.md`）及 `README.md` / `README_EN.md` 顶部的备份提示外，
本仓库的分支与标签内容**与上游完全一致**，未做任何修改。

> 因此 `main` 比上游 `main` **多 1 个提交**（仅添加上述提示）。其余 7 个分支与
> 11 个标签与上游逐字节一致。

## 如何重新同步 / How to re-sync

```bash
git clone --mirror https://github.com/Ebony-Vinyl/dsh-our-free-model.git
cd dsh-our-free-model.git
git remote add backup https://github.com/438417623wq/jidanAPI.git
git push backup --all
git push backup --tags
```

注意：由于 `main` 上存在本说明提交，直接推送 `main` 会被拒绝（non-fast-forward）。
若要保持纯镜像，可改用 `--force` 覆盖，或先删除本说明提交。

## 免责声明 / Disclaimer

本备份仓库与上游作者**无隶属或合作关系**，不代表上游作者立场。
若上游作者希望删除本备份，请通过本仓库 Issue 联系，将立即移除。
