/** Where the bytes live. Keys are always built by the server. */
export interface StorageDriver {
  readonly name: string;
  /** `contentType` is stored as object metadata by drivers that support it. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
