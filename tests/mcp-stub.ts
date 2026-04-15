// Minimal runtime stubs for the MCP SDK. The real clients spawn a child
// process via stdio; tests use these to intercept callTool() and assert the
// plugin parses server responses correctly.

export class StdioClientTransport {
  command: string;
  args: string[];
  closed = false;
  constructor(opts: { command: string; args: string[] }) {
    this.command = opts.command;
    this.args = opts.args;
  }
  async close() {
    this.closed = true;
  }
}

type ToolHandler = (args: any) => Promise<any> | any;

export class Client {
  static nextResponse: any = null;
  static nextError: Error | null = null;
  static nextDelayMs = 0;
  static calls: Array<{ name: string; arguments: any }> = [];
  static handler: ToolHandler | null = null;

  connected = false;
  closed = false;
  constructor(_info: any, _caps: any) {}

  async connect(_transport: any) {
    this.connected = true;
  }

  async close() {
    this.closed = true;
  }

  async callTool(req: { name: string; arguments: any }): Promise<any> {
    Client.calls.push(req);
    if (Client.nextDelayMs > 0) {
      await new Promise((r) => setTimeout(r, Client.nextDelayMs));
    }
    if (Client.nextError) {
      const e = Client.nextError;
      Client.nextError = null;
      throw e;
    }
    if (Client.handler) {
      return Client.handler(req.arguments);
    }
    const resp = Client.nextResponse;
    Client.nextResponse = null;
    return resp ?? { content: [] };
  }

  static reset() {
    Client.nextResponse = null;
    Client.nextError = null;
    Client.nextDelayMs = 0;
    Client.calls = [];
    Client.handler = null;
  }
}
