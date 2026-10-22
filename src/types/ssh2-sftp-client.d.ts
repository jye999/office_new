// Minimal ambient types for ssh2-sftp-client (package ships no types) —
// only the surface src/storage.ts uses.
declare module 'ssh2-sftp-client' {
  export interface SftpConnectConfig {
    host?: string;
    username?: string;
    password?: string;
    port?: number;
  }
  export default class SftpClient {
    connect(config: SftpConnectConfig): Promise<void>;
    end(): Promise<void>;
    put(data: Buffer | string, remotePath: string): Promise<void>;
    get(remotePath: string): Promise<Buffer>;
    stat(remotePath: string): Promise<unknown>;
    delete(remotePath: string): Promise<void>;
  }
}
