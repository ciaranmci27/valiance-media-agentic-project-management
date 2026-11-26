/**
 * How an agent's host connects to this workspace: the MCP URL, the REST
 * base and copy-ready snippets for Claude Code, Codex, any MCP client and a
 * plain env file. Pure, so the hire flow and an agent's Connect tab build the
 * same text.
 *
 * The stored snippets never hold a key. They read it from the PM_API_KEY
 * environment variable. While a key just made is on screen, the screens
 * show them with it written into the header (connectSnippetsWithKey), so
 * they paste and work; a key never goes in a URL.
 * Authentication is the v1 API key in x-api-key (the MCP route also takes
 * Authorization: Bearer, which is what Codex sends).
 */

/** The MCP server's key in every client config; tools arrive as mcp__pm__<tool>. */
export const MCP_SERVER_NAME = 'pm';
/** Where every snippet reads the key from. */
export const CONNECT_KEY_ENV = 'PM_API_KEY';
export const CONNECT_KEY_PLACEHOLDER = '<paste the key shown once>';

export interface ConnectSnippets {
  claude_code: string;
  codex: string;
  generic_mcp_json: string;
  env: string;
}

export interface ConnectInfo {
  mcp_url: string;
  api_base: string;
  key_env: string;
  snippets: ConnectSnippets;
}

/** The app's address without a trailing slash. */
export function appBase(appUrl: string): string {
  return appUrl.replace(/\/+$/, '');
}

/**
 * The same snippets with a key just made written in, for the moment it is on
 * screen, so they paste and work. The key only ever goes in a header
 * (x-api-key, which the MCP route and the v1 API read) or the env file's
 * value: never in a URL, which ends up in logs, history and proxies. With
 * no secret the snippets are as buildConnectInfo made them.
 */
export function connectSnippetsWithKey(info: ConnectInfo, secret: string | null | undefined): ConnectSnippets {
  const key = secret?.trim();
  if (!key) return info.snippets;
  const quotedToml = JSON.stringify(key);
  return {
    claude_code: `claude mcp add --transport http ${MCP_SERVER_NAME} ${info.mcp_url} --header "x-api-key: ${key}"`,
    codex: [
      '# ~/.codex/config.toml',
      `[mcp_servers.${MCP_SERVER_NAME}]`,
      `url = "${info.mcp_url}"`,
      `http_headers = { "x-api-key" = ${quotedToml} }`,
    ].join('\n'),
    generic_mcp_json: JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { type: 'http', url: info.mcp_url, headers: { 'x-api-key': key } },
      },
    }, null, 2),
    env: [
      `PM_API_URL=${info.api_base}`,
      `PM_MCP_URL=${info.mcp_url}`,
      `${info.key_env}=${key}`,
    ].join('\n'),
  };
}

export function buildConnectInfo(appUrl: string): ConnectInfo {
  const base = appBase(appUrl);
  const mcpUrl = `${base}/api/mcp`;
  const apiBase = `${base}/api/v1`;
  const env = CONNECT_KEY_ENV;
  return {
    mcp_url: mcpUrl,
    api_base: apiBase,
    key_env: env,
    snippets: {
      claude_code: `claude mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl} --header "x-api-key: \${${env}}"`,
      codex: [
        '# ~/.codex/config.toml',
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        `url = "${mcpUrl}"`,
        `bearer_token_env_var = "${env}"`,
      ].join('\n'),
      generic_mcp_json: JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl, headers: { 'x-api-key': `\${${env}}` } },
        },
      }, null, 2),
      env: [
        `PM_API_URL=${apiBase}`,
        `PM_MCP_URL=${mcpUrl}`,
        `${env}=${CONNECT_KEY_PLACEHOLDER}`,
      ].join('\n'),
    },
  };
}
