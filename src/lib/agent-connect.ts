/**
 * How an agent's host connects to this workspace: the MCP URL, the REST
 * base and copy-ready snippets for Claude Code, Codex, any MCP client and a
 * plain env file. Pure, so the hire flow and an agent's Connect tab build the
 * same text.
 *
 * The snippets never hold a key. They read it from the PM_API_KEY
 * environment variable, so a key shown once is pasted in one place (the
 * host's env) and never lands in a config file, a chat or a screenshot.
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
