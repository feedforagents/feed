import { describe, expect, it } from 'bun:test';
import { MCPRequestHandler } from '../../../mcp/src/handlers/mcp-request-handler';
import { MCPMethod } from '../../../mcp/src/types/mcp';

describe('MCPRequestHandler auth context', () => {
  it('does not reuse an earlier caller auth context for a later request', async () => {
    const handler = new MCPRequestHandler();

    const ping = await handler.handle(
      { jsonrpc: '2.0', id: 1, method: MCPMethod.PING },
      { apiKey: 'someone-elses-key' }
    );
    expect(ping.error).toBeUndefined();

    const call = await handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: MCPMethod.TOOLS_CALL,
      params: { name: 'get_balance', arguments: {} },
    });
    expect(call.error?.code).toBe(-32000);
    expect(call.error?.message).toBe('Authentication required');
  });
});

describe('MCPRequestHandler capability negotiation', () => {
  // The request a client sends for each optional server capability it sees
  // in the initialize result (MCP spec, server features and utilities).
  const capabilityRequests: Record<
    string,
    { method: string; params?: Record<string, string> }
  > = {
    logging: { method: 'logging/setLevel', params: { level: 'debug' } },
    resources: { method: 'resources/list' },
    prompts: { method: 'prompts/list' },
    tools: { method: MCPMethod.TOOLS_LIST },
  };

  it('serves the request a client sends for every capability it advertises', async () => {
    const handler = new MCPRequestHandler();
    const init = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: MCPMethod.INITIALIZE,
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'inspector-cli', version: '2.16.0' },
      },
    });
    const advertised = Object.keys(
      (init.result as { capabilities: Record<string, unknown> }).capabilities
    );
    expect(advertised).toContain('tools');

    let id = 2;
    for (const capability of advertised) {
      const request = capabilityRequests[capability];
      if (!request)
        throw new Error(`no client request known for ${capability}`);
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: id++,
        method: request.method,
        params: request.params,
      });
      expect({ capability, error: response.error }).toEqual({
        capability,
        error: undefined,
      });
    }
  });
});
