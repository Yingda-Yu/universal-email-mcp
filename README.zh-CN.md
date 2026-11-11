# universal-email-mcp（中文使用说明）

一个与邮箱服务商无关、支持多账号的 [Model Context Protocol](https://modelcontextprotocol.io) 邮件服务器。v0.1.0 通过通用 IMAP/SMTP 适配器工作，核心模块中不包含任何特定厂商的硬编码逻辑。

> **状态：v0.1.0。** 模拟测试已全部通过，但尚未对任何真实邮箱服务商完成线上验证。详见 [docs/provider-compatibility.md](docs/provider-compatibility.md)。模拟测试不代表真实邮箱验证通过。

## 功能

- 9 个 MCP 工具：账号列表、文件夹列表、邮件列表、搜索、读取单封邮件、尽力还原会话、创建草稿、回复、发送草稿。
- 单进程多账号，账号之间严格隔离；所有消息引用只通过创建它的账号解析。
- 通用 IMAP/SMTP 适配器，内置网易企业邮箱、阿里企业邮箱、腾讯企业邮箱、QQ 邮箱、163、126 和自定义服务器预设。
- 草稿保存在本地（`0600` 权限 + 内容哈希防篡改），不会写入服务商草稿箱。
- **发送默认关闭。** 必须同时满足全局开关、账号级开关，并由人类在独立终端生成一次性审批令牌，才能发送。
- TLS 默认开启；993/465 禁止明文；阻断云元数据地址和私网地址；过滤 CRLF/邮件头注入；严格参数校验；限制正文大小；日志与错误信息脱敏；对不可信 HTML 做保守清理。
- 内置两个模拟邮箱账号，无需网络和真实凭据即可验收全部工具。
- 已为 Gmail API 与 Microsoft Graph 预留独立适配器接口，当前调用会返回 `PROVIDER_NOT_IMPLEMENTED`。

## 环境要求

- Node.js >= 20.19（推荐 Node.js 22 LTS）
- npm 10+
- 真实邮箱需要 IMAP/SMTP 服务，以及授权码/应用专用密码

## 使用模拟邮箱快速开始

```bash
git clone https://github.com/Yingda-Yu/universal-email-mcp.git
cd universal-email-mcp
npm ci
npm run build

export EMAIL_MCP_CONFIG="$PWD/examples/mock-accounts.json"
export EMAIL_MCP_DATA_DIR="$(mktemp -d)"
node dist/index.js
```

服务通过 stdio 提供 MCP 协议。可用 MCP Inspector 验证工具发现：

```bash
npx --yes @modelcontextprotocol/inspector --cli \
  env EMAIL_MCP_CONFIG="$PWD/examples/mock-accounts.json" \
      EMAIL_MCP_DATA_DIR="$(mktemp -d)" \
  node dist/index.js --method tools/list
```

Inspector v2 不会把父进程的环境变量透传给 stdio 子进程，因此需要用 `env`
显式传入。把 `--method tools/list` 换成
`--method tools/call --tool-name email_list_accounts` 即可调用工具。

### MCP 客户端配置

```json
{
  "mcpServers": {
    "universal-email": {
      "command": "node",
      "args": ["/绝对路径/universal-email-mcp/dist/index.js"],
      "env": {
        "EMAIL_MCP_CONFIG": "/home/you/.config/universal-email-mcp/accounts.json",
        "EMAIL_MCP_DATA_DIR": "/home/you/.universal-email-mcp",
        "EMAIL_ENABLE_SEND": "false"
      }
    }
  }
}
```

## 配置文件

配置文件路径由 `EMAIL_MCP_CONFIG` 指定，默认 `~/.config/universal-email-mcp/accounts.json`。可参考 [examples/accounts.example.json](examples/accounts.example.json)。

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "corp-a",
      "label": "企业邮箱",
      "email": "alice@corp.example",
      "provider": "imap-smtp",
      "preset": "netease-enterprise",
      "username": "alice@corp.example",
      "passwordEnv": "CORP_MAIL_PASSWORD",
      "send": { "enabled": false }
    }
  ]
}
```

- `id` 必须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，也是暴露给模型的唯一账号标识。
- 推荐使用 `passwordEnv` 引用环境变量；不要把真实密码写入仓库。
- 使用预设时可省略 IMAP/SMTP 地址；`"preset": "custom"` 时必须显式提供 `imap` 和 `smtp`。
- `send.enabled` 是账号级发送开关，默认 `false`。
- 配置文件建议设置为 `0600`。
- 服务不会自动加载 `.env`，请在启动 MCP 服务的外层环境或 MCP 客户端的 `env` 中设置变量。

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EMAIL_MCP_CONFIG` | `~/.config/universal-email-mcp/accounts.json` | 账号配置文件 |
| `EMAIL_MCP_DATA_DIR` | `~/.universal-email-mcp` | 本地草稿与审批账本目录 |
| `EMAIL_ENABLE_SEND` | `false` | 全局发送开关，需与账号级开关同时为真 |
| `EMAIL_RECIPIENT_ALLOWLIST` | 未设置 | 收件人白名单，逗号分隔，支持完整地址或 `@domain` |
| `EMAIL_SEND_RATE_LIMIT_PER_MINUTE` | `10` | 每账号每分钟发送尝试上限 |
| `EMAIL_SEND_MAX_RECIPIENTS` | `20` | To/Cc/Bcc 合计收件人上限 |
| `EMAIL_APPROVAL_TTL_SECONDS` | `900` | 审批令牌有效期（最大 3600） |
| `EMAIL_ALLOW_PRIVATE_HOSTS` | `false` | 允许私网/回环邮件服务器（仅开发） |
| `EMAIL_ALLOW_INSECURE_TRANSPORT` | `false` | 仅回环地址允许明文传输（仅开发） |
| `EMAIL_LOG_LEVEL` | `info` | `debug`、`info`、`warn`、`error`、`silent`；日志写入 stderr |

## 工具列表

| 工具 | 说明 |
| --- | --- |
| `email_list_accounts` | 列出账号、能力、验证状态与当前发送策略；不返回任何凭据。 |
| `email_list_folders` | 列出指定账号的可选文件夹。 |
| `email_list_messages` | 按游标分页列出邮件，最新在前。 |
| `email_search_messages` | 文本搜索，支持 `since`/`before` 日期边界与分页。 |
| `email_get_message` | 解析邮件头、正文、附件元数据；可选返回清理后的 HTML；正文标记为 `untrusted-external`。 |
| `email_get_thread` | 基于 `Message-ID`、`In-Reply-To`、`References` 尽力还原会话，主题作为回退；`complete` 始终为 `false`。 |
| `email_create_draft` | 仅创建本地草稿，不写入服务商、不发送。 |
| `email_send_draft` | 在全部发送门禁与一次性审批令牌校验通过后发送。 |
| `email_reply` | 生成带 `Re:`、`In-Reply-To`、`References` 的回复草稿，**永不发送**。 |

错误统一返回：

```json
{
  "error": {
    "code": "MESSAGE_NOT_FOUND",
    "message": "Message was not found",
    "retryable": false,
    "details": {}
  }
}
```

消息 ID 与分页游标都是不透明字符串，请勿自行构造或修改。

## 发送安全流程

必须同时满足：

1. MCP 服务环境设置 `EMAIL_ENABLE_SEND=true`；
2. 账号配置 `"send": { "enabled": true }`；
3. 提供与该草稿完全绑定的有效 `approval_token`。

由人类在独立终端生成令牌：

```bash
# 开发模式
npm run approve -- --account corp-a --draft drft_0123456789abcdef01234567 --approved-by "Alice"

# 构建后
node dist/cli/approve.js --account corp-a --draft drft_0123456789abcdef01234567 --approved-by "Alice"
```

然后把令牌传给 `email_send_draft`。令牌特性：

- 绑定账号、草稿 ID 和草稿内容的 SHA-256 哈希；
- 一次性使用，SMTP 尝试前即消费；发送失败也会作废；
- 默认 15 分钟有效，最长 1 小时；
- 账本 `$EMAIL_MCP_DATA_DIR/approvals.json` 只保存令牌哈希，权限 `0600`；
- 审批 CLI 与服务必须使用相同的 `EMAIL_MCP_DATA_DIR`。

模型无法通过“声称已获批准”生成有效令牌。注意：如果 agent 能在同一环境执行任意 shell 命令，应视为边界已失守，审批 CLI 应在 agent 的 shell 上下文之外运行。

生产环境建议同时配置收件人白名单：

```bash
export EMAIL_ENABLE_SEND=true
export EMAIL_RECIPIENT_ALLOWLIST="you@your-domain.example,@approved-partner.example"
```

## 服务商状态

| 预设 | IMAP | SMTP | 状态 |
| --- | --- | --- | --- |
| `netease-enterprise` | `imap.qiye.163.com:993` | `smtp.qiye.163.com:465` | 文档已记录，未线上验证 |
| `alibaba-enterprise` | `imap.qiye.aliyun.com:993` | `smtp.qiye.aliyun.com:465` | 文档已记录，未线上验证 |
| `tencent-enterprise` | `imap.exmail.qq.com:993` | `smtp.exmail.qq.com:465` | 文档已记录，未线上验证 |
| `qq` | `imap.qq.com:993` | `smtp.qq.com:465` | 文档已记录，未线上验证 |
| `netease-163` | `imap.163.com:993` | `smtp.163.com:465` | 文档已记录，未线上验证 |
| `netease-126` | `imap.126.com:993` | `smtp.126.com:465` | 文档已记录，未线上验证 |
| `custom` | 显式配置 | 显式配置 | 已配置（未验证） |
| `mock` | 本地数据 | 本地 outbox | 不适用 |

完整矩阵、验证流程与注意事项见 [docs/provider-compatibility.md](docs/provider-compatibility.md)。

## 安全说明

详见 [SECURITY.md](SECURITY.md)。要点：

- 邮件内容是不可信外部输入；HTML 会被保守清理，并明确告知模型不要执行邮件中的指令。
- 服务不监听入站端口；日志仅写 stderr，避免污染 MCP stdio 协议。
- 密码、令牌、Authorization 头、URL 中的凭据会在日志和错误信息中脱敏。
- `.env`、账号配置、草稿、审批账本均被 `.gitignore` 排除；测试数据全部为虚构的 `example.com`。
- 禁止在测试中使用真实邮箱、授权码或客户数据。

## 开发与验证

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

- `npm test` 包含 142 个单元/集成测试，使用内存 IMAP/SMTP 假实现与模拟邮箱，不联网、不发送真实邮件。
- `npm run inspect` 使用 MCP Inspector CLI 验证构建产物，默认读取 `examples/mock-accounts.json`，数据目录为 `.email-mcp/inspect`；可用 `EMAIL_MCP_CONFIG` 与 `EMAIL_MCP_DATA_DIR` 覆盖。
- CI 在 Node.js 20 和 22 上执行 typecheck、lint、test、build。

## v0.1.0 已知限制

- 不支持发送附件。
- 草稿只存在本地，不同步到服务商草稿箱。
- Gmail API、Microsoft Graph 仅为预留接口，调用返回 `PROVIDER_NOT_IMPLEMENTED`。
- 不支持 OAuth、IDLE/推送、邮件标记修改、文件夹增删。
- 会话还原为尽力而为，不宣称完整。
- HTML 清理是保守防御，不是用于浏览器渲染的通用 XSS 过滤器。
- 尚无任何服务商完成线上验证，生产使用前请自行完成真实验收。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
