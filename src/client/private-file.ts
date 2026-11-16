import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";

/** Zero on Windows, which has no O_NOFOLLOW; `refuseLink` checks there instead. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Throws when `file` is a symbolic link: Tether never writes or chmods through one. */
function refuseLink(file: string): void {
  let link = false;
  try {
    link = lstatSync(file).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (link) {
    throw new Error(`${file} is a symbolic link; Tether does not write through one. Remove it.`);
  }
}

/**
 * Opens `file` with `flags` and never through a symbolic link: the lstat check names the file
 * (and stands in on Windows), and O_NOFOLLOW still fails the open on a link put there since.
 */
function openOwn(file: string, flags: number, mode?: number): number {
  refuseLink(file);
  return openSync(file, flags | NOFOLLOW, mode);
}

/**
 * Creates `file` fresh, readable only by the user, and writes `content` to it. Whatever was at the
 * path is removed first, a symbolic link as a link, so a stale temporary file cannot block a write
 * or redirect it; the exclusive create then refuses anything put there in between.
 */
export function createPrivate(file: string, content: string | Uint8Array): void {
  rmSync(file, { force: true });
  const fd = openOwn(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** Makes an existing `file` readable only by the user; refuses a symbolic link. */
export function makePrivate(file: string): void {
  const fd = openOwn(file, constants.O_RDONLY);
  try {
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

/**
 * Keeps the last `keep` bytes of `file`, from the first whole line in them, once it is larger than
 * `max` bytes. Cut in place on one descriptor, never through a symbolic link, and left readable
 * only by the user. A missing file is left alone.
 */
export function cutToTail(file: string, max: number, keep: number): void {
  let fd: number;
  try {
    fd = openOwn(file, constants.O_RDWR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= max) return;
    const tail = Buffer.alloc(keep);
    readSync(fd, tail, 0, keep, size - keep);
    // Start on a whole line: the first one in the tail is most likely cut.
    const kept = tail.subarray(tail.indexOf(0x0a) + 1);
    ftruncateSync(fd, 0);
    // Reads at a position leave the descriptor's offset at 0, where this write starts.
    writeFileSync(fd, kept);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}
