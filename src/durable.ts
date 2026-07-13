import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

function syncDirectory(directory: string): void {
  const directoryDescriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

/**
 * Atomically replace one private state file and durably commit both the file
 * contents and directory entry. These files carry credentials, live lease
 * authority, or pre-spawn quota debits, so rename-only durability is not
 * sufficient across a host crash or power loss.
 */
export function writePrivateFileDurably(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fileDescriptor: number | null = null;
  let renamed = false;
  try {
    fileDescriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(fileDescriptor, contents, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;
    renameSync(temporary, path);
    renamed = true;
    chmodSync(path, 0o600);

    syncDirectory(directory);
  } finally {
    if (fileDescriptor != null) closeSync(fileDescriptor);
    if (!renamed) rmSync(temporary, { force: true });
  }
}

export function writePrivateJsonDurably(path: string, value: unknown): void {
  writePrivateFileDurably(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function renamePathDurably(source: string, destination: string): void {
  const sourceDirectory = dirname(source);
  const destinationDirectory = dirname(destination);
  renameSync(source, destination);
  syncDirectory(sourceDirectory);
  if (destinationDirectory !== sourceDirectory) syncDirectory(destinationDirectory);
}
