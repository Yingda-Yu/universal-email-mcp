import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmailMcpServer } from '../../src/server.js';
import { createMockHarness, type MockHarness } from '../helpers/harness.js';

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as CallToolResult).content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  expect(text).toBeDefined();
  return JSON.parse(text as string) as Record<string, unknown>;
}

describe('MCP server over in-memory transport', () => {
  let harness: MockHarness;
  let client: Client;

  beforeEach(async () => {
    harness = await createMockHarness();
    const server = createEmailMcpServer(harness);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'universal-email-mcp-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await harness.cleanup();
  });

  it('discovers all nine email tools with descriptions and safety annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'email_create_draft',
      'email_get_message',
      'email_get_thread',
      'email_list_accounts',
      'email_list_folders',
      'email_list_messages',
      'email_reply',
      'email_search_messages',
      'email_send_draft',
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(20);
    }
    const sendTool = tools.find((tool) => tool.name === 'email_send_draft');
    expect(sendTool?.description).toContain('approval token');
    expect(sendTool?.annotations?.destructiveHint).toBe(true);
    const replyTool = tools.find((tool) => tool.name === 'email_reply');
    expect(replyTool?.description).toContain('NEVER sends');
  });

  it('invokes account and message listing tools', async () => {
    const accounts = await client.callTool({ name: 'email_list_accounts', arguments: {} });
    expect(accounts.isError).toBeFalsy();
    const accountsPayload = payloadOf(accounts);
    expect((accountsPayload['accounts'] as unknown[]).length).toBe(2);

    const messages = await client.callTool({
      name: 'email_list_messages',
      arguments: { account_id: 'demo-a', folder: 'INBOX', limit: 2 },
    });
    expect(messages.isError).toBeFalsy();
    const messagesPayload = payloadOf(messages);
    expect((messagesPayload['messages'] as unknown[]).length).toBe(2);
    expect(messagesPayload['next_cursor']).toEqual(expect.any(String));
  });

  it('returns structured tool errors over the protocol', async () => {
    const result = await client.callTool({
      name: 'email_list_folders',
      arguments: { account_id: 'missing-account' },
    });
    expect(result.isError).toBe(true);
    const error = payloadOf(result)['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNKNOWN_ACCOUNT');
    expect(error['retryable']).toBe(false);
  });

  it('creates a local draft and denies sending while disabled', async () => {
    const created = await client.callTool({
      name: 'email_create_draft',
      arguments: {
        account_id: 'demo-a',
        to: ['alex@example.com'],
        subject: 'MCP protocol draft',
        text: 'Created through the MCP protocol.',
      },
    });
    expect(created.isError).toBeFalsy();
    const draft = payloadOf(created)['draft'] as Record<string, unknown>;
    expect(draft['status']).toBe('local_draft');

    const sent = await client.callTool({
      name: 'email_send_draft',
      arguments: {
        account_id: 'demo-a',
        draft_id: draft['draft_id'],
        approval_token: 'A'.repeat(43),
      },
    });
    expect(sent.isError).toBe(true);
    const error = payloadOf(sent)['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SEND_DISABLED');
    expect(harness.mockProvider('demo-a').getOutbox()).toHaveLength(0);
  });

  it('rejects schema-invalid tool arguments at the protocol boundary', async () => {
    const result = await client.callTool({
      name: 'email_list_messages',
      arguments: { account_id: 'demo-a', limit: 999 },
    });
    expect(result.isError).toBe(true);
  });
});
