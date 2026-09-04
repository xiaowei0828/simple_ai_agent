import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export async function readUtf8Prefix(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return new StringDecoder("utf8").write(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
